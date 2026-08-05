/**
 * HubSpot ActivitySource — historical + incremental deal activity through the
 * Nango proxy (same seam as the GitHub adapter; credentials never touch this
 * process). HubSpot is a department anchor (sales/marketing/csm), so this
 * gives non-engineering orgs the same persona depth GitHub gives engineering
 * orgs. v1 ingests deals: creation is the strongest observed-work signal the
 * CRM offers without touching contact PII (deal names + stages only; emails
 * and contact records are never read).
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import {
  windowStart,
  type ActivitySource,
  type BackfillBatch,
  type BackfillWindow,
  type NormalizedActivity,
  type SourceContext,
} from '../types'

const PAGE_SIZE = 100
const CALL_TIMEOUT_MS = 30_000
const SYNC_MAX_PAGES = 2

type HubspotHistoryEntry = { value?: unknown; timestamp?: unknown }

type HubspotDeal = {
  id?: unknown
  properties?: {
    dealname?: unknown
    dealstage?: unknown
    createdate?: unknown
    hubspot_owner_id?: unknown
    amount?: unknown
  }
  propertiesWithHistory?: {
    dealstage?: HubspotHistoryEntry[]
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(nango.proxy(args as never) as Promise<{ data: unknown }>, CALL_TIMEOUT_MS, `HubSpot ${args.endpoint}`)
}

export function hubspotDealActivity(item: HubspotDeal): NormalizedActivity | null {
  const id = typeof item.id === 'string' ? item.id : null
  const created = typeof item.properties?.createdate === 'string' ? new Date(item.properties.createdate) : null
  if (!id || !created || Number.isNaN(created.getTime())) return null
  const owner = typeof item.properties?.hubspot_owner_id === 'string' && item.properties.hubspot_owner_id
    ? item.properties.hubspot_owner_id
    : 'unknown'
  return {
    source: 'hubspot',
    actorRef: owner,
    action: 'created_deal',
    entityType: 'deal',
    entityRef: id,
    entityName: typeof item.properties?.dealname === 'string' ? item.properties.dealname.slice(0, 200) : null,
    businessContext: {
      ...(typeof item.properties?.dealstage === 'string' ? { stage: item.properties.dealstage } : {}),
    },
    occurredAt: created,
    dedupeKey: `hubspot:deal:${id}`,
  }
}

/** HubSpot history timestamps are epoch-ms strings. Null on anything else. */
function historyTimestamp(raw: unknown): Date | null {
  const ms = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * One event per stage transition. HubSpot returns history newest-first, so
 * entry i is the state entered and entry i+1 the state it replaced. The
 * oldest entry has no predecessor — it is the initial stage, not a
 * transition, and is dropped.
 *
 * This is the only HubSpot signal that carries previousState, which is what
 * makes deal cycle time measurable at all. Inert when the caller fetched
 * through an endpoint that omits property history: no history, no events.
 */
export function hubspotStageChangeActivities(item: HubspotDeal): NormalizedActivity[] {
  const id = typeof item.id === 'string' ? item.id : null
  const history = item.propertiesWithHistory?.dealstage
  if (!id || !Array.isArray(history) || history.length < 2) return []

  const owner =
    typeof item.properties?.hubspot_owner_id === 'string' && item.properties.hubspot_owner_id
      ? item.properties.hubspot_owner_id
      : 'unknown'
  const dealName = typeof item.properties?.dealname === 'string' ? item.properties.dealname.slice(0, 200) : null

  const events: NormalizedActivity[] = []
  for (let index = 0; index < history.length - 1; index += 1) {
    const entered = history[index]
    const replaced = history[index + 1]
    const occurredAt = historyTimestamp(entered?.timestamp)
    const toStage = typeof entered?.value === 'string' ? entered.value : null
    const fromStage = typeof replaced?.value === 'string' ? replaced.value : null
    if (!occurredAt || !toStage || !fromStage) continue

    events.push({
      source: 'hubspot',
      actorRef: owner,
      action: 'deal_stage_changed',
      entityType: 'deal',
      entityRef: id,
      entityName: dealName,
      previousState: { stage: fromStage },
      newState: { stage: toStage },
      businessContext: { stage: toStage },
      occurredAt,
      dedupeKey: `hubspot:deal:${id}:stage:${occurredAt.getTime()}`,
    })
  }
  return events
}

async function resolveConnection(ctx: SourceContext): Promise<{ connectionId: string; providerConfigKey: string } | null> {
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId: ctx.connectionRef },
    select: { connectionId: true, providerConfigKey: true },
  })
}

type SearchPage = { deals: HubspotDeal[]; after?: string }

async function searchDeals(
  proxy: NangoProxy,
  connection: { connectionId: string; providerConfigKey: string },
  since: Date | null,
  after?: string,
): Promise<SearchPage> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/crm/v3/objects/deals/search',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: {
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      properties: ['dealname', 'dealstage', 'createdate', 'hubspot_owner_id'],
      ...(since
        ? { filterGroups: [{ filters: [{ propertyName: 'createdate', operator: 'GTE', value: String(since.getTime()) }] }] }
        : {}),
    },
  })
  const data = response.data as { results?: unknown[]; paging?: { next?: { after?: unknown } } }
  return {
    deals: Array.isArray(data.results) ? (data.results as HubspotDeal[]) : [],
    after: typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined,
  }
}

export function makeHubspotActivitySource(proxyOverride?: NangoProxy): ActivitySource {
  return {
    source: 'hubspot',
    capabilities: { backfill: true, webhooks: false, incrementalSync: true },
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const connection = await resolveConnection(ctx)
      if (!connection) return
      const proxy = proxyOverride ?? defaultProxy()
      const since = windowStart(window, new Date())
      let after = cursor
      do {
        let page: SearchPage
        try {
          page = await searchDeals(proxy, connection, since, after)
        } catch (error) {
          apiLogger.warn('hubspot backfill: page fetch failed, stopping run', {
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], ...(after ? { nextCursor: after } : {}) }
          return
        }
        const events = page.deals
          .map((deal) => hubspotDealActivity(deal))
          .filter((event): event is NormalizedActivity => event !== null)
        after = page.after
        yield { events, ...(after ? { nextCursor: after } : {}) }
      } while (after)
    },
    async handleEvent() {
      return []
    },
    async incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]> {
      const connection = await resolveConnection(ctx)
      if (!connection) return []
      const proxy = proxyOverride ?? defaultProxy()
      const events: NormalizedActivity[] = []
      let after: string | undefined
      let pages = 0
      try {
        do {
          const page = await searchDeals(proxy, connection, since, after)
          for (const deal of page.deals) {
            const event = hubspotDealActivity(deal)
            if (event) events.push(event)
          }
          after = page.after
          pages += 1
        } while (after && pages < SYNC_MAX_PAGES)
      } catch (error) {
        apiLogger.warn('hubspot incremental sync failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return events
    },
  }
}

export const hubspotActivitySource = makeHubspotActivitySource()
