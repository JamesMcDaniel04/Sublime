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

export type HubspotEngagement = {
  id?: unknown
  properties?: {
    hs_timestamp?: unknown
    hubspot_owner_id?: unknown
    hs_task_status?: unknown
    hs_task_type?: unknown
    hs_email_subject?: unknown
  }
}

const ENGAGEMENT_ACTIONS = {
  email: { action: 'logged_email', entityType: 'email' },
  call: { action: 'logged_call', entityType: 'call' },
  task: { action: 'completed_task', entityType: 'task' },
} as const

/**
 * Engagements are the recurring RevOps work deals alone miss. Task completion
 * is a transition and carries previousState; emails and calls are point
 * events. Subjects and bodies are never recorded — they carry customer PII and
 * the baseline layer needs only counts and timing.
 */
export function hubspotEngagementActivity(
  kind: 'email' | 'call' | 'task',
  item: HubspotEngagement,
): NormalizedActivity | null {
  const id = typeof item.id === 'string' ? item.id : null
  const raw = item.properties?.hs_timestamp
  const occurredAt = typeof raw === 'string' ? new Date(raw) : null
  if (!id || !occurredAt || Number.isNaN(occurredAt.getTime())) return null

  const status = typeof item.properties?.hs_task_status === 'string' ? item.properties.hs_task_status : null
  // Only completed tasks are observed work. An open task is work pending.
  if (kind === 'task' && status !== 'COMPLETED') return null

  const owner =
    typeof item.properties?.hubspot_owner_id === 'string' && item.properties.hubspot_owner_id
      ? item.properties.hubspot_owner_id
      : 'unknown'
  const taskType = typeof item.properties?.hs_task_type === 'string' ? item.properties.hs_task_type : null

  return {
    source: 'hubspot',
    actorRef: owner,
    action: ENGAGEMENT_ACTIONS[kind].action,
    entityType: ENGAGEMENT_ACTIONS[kind].entityType,
    entityRef: id,
    entityName: null,
    ...(kind === 'task' ? { previousState: { status: 'open' }, newState: { status } } : {}),
    businessContext: taskType ? { taskType } : {},
    occurredAt,
    dedupeKey: `hubspot:${kind}:${id}`,
  }
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

/**
 * Deal fetch through the list endpoint — the only one that returns
 * `propertiesWithHistory`, and therefore the only source of stage
 * transitions. NOT yet used by the live backfill: the response shape is
 * unverified against a real portal (no HubSpot connection exists on the
 * configured Nango account), and this endpoint also loses the server-side
 * `createdate` filter that `searchDeals` gets, so swapping it in unverified
 * would trade a working fetch for a slower one with no confirmed gain.
 *
 * See the Verification section of
 * docs/superpowers/specs/2026-08-03-day-one-roi-design.md for the swap.
 */
export async function listDealsWithHistory(
  proxy: NangoProxy,
  connection: { connectionId: string; providerConfigKey: string },
  after?: string,
): Promise<SearchPage> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/crm/v3/objects/deals',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: {
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
      properties: 'dealname,dealstage,createdate,hubspot_owner_id',
      propertiesWithHistory: 'dealstage',
    },
  })
  const data = response.data as { results?: unknown[]; paging?: { next?: { after?: unknown } } }
  return {
    deals: Array.isArray(data.results) ? (data.results as HubspotDeal[]) : [],
    after: typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined,
  }
}

/** Backfill walks deals, then each engagement object type in turn. The phase
 *  travels in the cursor so a resumed run picks up where it stopped. */
type HubspotCursor = { phase: 'deals' | 'email' | 'call' | 'task'; after?: string }

const ENGAGEMENT_PHASES = ['email', 'call', 'task'] as const

const ENGAGEMENT_PROPERTIES: Record<string, string> = {
  email: 'hs_timestamp,hubspot_owner_id',
  call: 'hs_timestamp,hubspot_owner_id',
  task: 'hs_timestamp,hubspot_owner_id,hs_task_status,hs_task_type',
}

/**
 * Cursor format changed from a bare `after` string to a phased JSON object.
 * A backfill checkpointed under the old format is still in flight when this
 * ships, so a non-JSON cursor is read as a deals-phase offset rather than
 * crashing the resumed run.
 */
export function parseHubspotCursor(cursor?: string): HubspotCursor {
  if (!cursor) return { phase: 'deals' }
  try {
    const parsed = JSON.parse(cursor) as Partial<HubspotCursor>
    const phase = parsed?.phase
    if (phase === 'deals' || phase === 'email' || phase === 'call' || phase === 'task') {
      return { phase, ...(typeof parsed.after === 'string' ? { after: parsed.after } : {}) }
    }
    return { phase: 'deals' }
  } catch {
    return { phase: 'deals', after: cursor }
  }
}

export async function listEngagements(
  proxy: NangoProxy,
  connection: { connectionId: string; providerConfigKey: string },
  kind: 'email' | 'call' | 'task',
  after?: string,
): Promise<{ items: HubspotEngagement[]; after?: string }> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/crm/v3/objects/${kind}s`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { limit: PAGE_SIZE, ...(after ? { after } : {}), properties: ENGAGEMENT_PROPERTIES[kind] },
  })
  const data = response.data as { results?: unknown[]; paging?: { next?: { after?: unknown } } }
  return {
    items: Array.isArray(data.results) ? (data.results as HubspotEngagement[]) : [],
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
      let state = parseHubspotCursor(cursor)

      while (true) {
        let events: NormalizedActivity[] = []
        let nextAfter: string | undefined
        try {
          if (state.phase === 'deals') {
            const page = await searchDeals(proxy, connection, since, state.after)
            // Stage changes are mapped here too so the pending switch from
            // `searchDeals` to `listDealsWithHistory` is a one-line change.
            // Search results carry no property history, so this contributes
            // nothing until that switch happens.
            events = page.deals
              .flatMap((deal) => [hubspotDealActivity(deal), ...hubspotStageChangeActivities(deal)])
              .filter((event): event is NormalizedActivity => event !== null)
            nextAfter = page.after
          } else {
            const page = await listEngagements(proxy, connection, state.phase, state.after)
            events = page.items
              .map((item) => hubspotEngagementActivity(state.phase as 'email' | 'call' | 'task', item))
              .filter((event): event is NormalizedActivity => event !== null)
            nextAfter = page.after
          }
        } catch (error) {
          apiLogger.warn('hubspot backfill: page fetch failed, stopping run', {
            phase: state.phase,
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], nextCursor: JSON.stringify(state) }
          return
        }

        // The engagement endpoints have no server-side date filter, so the
        // window is enforced here. Deals are already filtered server-side;
        // re-checking them is harmless.
        const inWindow = events.filter((event) => !since || event.occurredAt >= since)

        if (nextAfter) {
          state = { phase: state.phase, after: nextAfter }
          yield { events: inWindow, nextCursor: JSON.stringify(state) }
          continue
        }

        const phaseIndex = state.phase === 'deals' ? -1 : ENGAGEMENT_PHASES.indexOf(state.phase)
        const nextPhase = ENGAGEMENT_PHASES[phaseIndex + 1]
        if (!nextPhase) {
          yield { events: inWindow }
          return
        }
        state = { phase: nextPhase }
        yield { events: inWindow, nextCursor: JSON.stringify(state) }
      }
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
