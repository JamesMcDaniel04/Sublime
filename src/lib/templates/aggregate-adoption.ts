/**
 * Global k-anonymous template adoption aggregation.
 *
 * Privacy model: the ONLY things that cross an org boundary are per-template
 * COUNTS — deploys, surviving deployments, distinct orgs. No org ids, user
 * ids, or deployed resource ids are stored. Rows are k-anonymous BY
 * CONSTRUCTION: a template key is upserted only when >= MIN_ADOPTION_ORGS
 * distinct orgs have deployed it, and stored rows falling below the floor are
 * deleted on the next sweep.
 *
 * This replaces a read-time cross-org aggregation that had no floor and
 * silently truncated at 5k events. Runs as a daily global cron sweep
 * (systemPrisma: cross-tenant by design, CRON_SECRET-gated at the route).
 * Pure helpers carry the math so the k-anonymity contract is testable
 * without a database.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { templateKeyOfContext } from './adoption'

/** k-anonymity floor: templates deployed by fewer orgs never surface. */
export const MIN_ADOPTION_ORGS = Math.max(2, Number(process.env.TEMPLATE_ADOPTION_MIN_ORGS) || 5)

/** Survival window: a deploy still running after this long is real evidence. */
const WINDOW_DAYS = 90
/** Page size for the ledger scan. Paged, not capped — see PAGE_LIMIT note. */
const PAGE_SIZE = 2_000

export type AdoptionEvent = {
  templateKey: string
  organizationId: string
  resourceId: string | null
}

export type TemplateAdoptionRow = {
  templateKey: string
  deploys: number
  surviving: number
  orgCount: number
}

/**
 * Cross-org aggregation with the k-anonymity floor applied. Pure: the floor
 * is a parameter so the contract is testable without touching env or a db.
 */
export function computeTemplateAdoption(
  events: AdoptionEvent[],
  survivingResourceIds: ReadonlySet<string>,
  minOrgs: number = MIN_ADOPTION_ORGS,
): TemplateAdoptionRow[] {
  const totals = new Map<
    string,
    { deploys: number; surviving: number; orgs: Set<string> }
  >()
  for (const event of events) {
    const acc = totals.get(event.templateKey) ?? {
      deploys: 0,
      surviving: 0,
      orgs: new Set<string>(),
    }
    acc.deploys += 1
    if (event.resourceId && survivingResourceIds.has(event.resourceId)) acc.surviving += 1
    acc.orgs.add(event.organizationId)
    totals.set(event.templateKey, acc)
  }
  return [...totals.entries()]
    .filter(([, acc]) => acc.orgs.size >= minOrgs)
    .map(([templateKey, acc]) => ({
      templateKey,
      deploys: acc.deploys,
      surviving: acc.surviving,
      orgCount: acc.orgs.size,
    }))
}

/**
 * The dispatch cron ticks every 15 minutes, so exactly one tick lands in the
 * [03:00, 03:15) UTC window. Deliberately an hour before the archetype and
 * benchmark sweeps, which read adoption scores — they get fresh counts.
 */
export function shouldRunAdoptionSweep(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 15
}

/**
 * The daily sweep: read the full template_used window, aggregate with the
 * k-anonymity floor, upsert qualifying rows, and delete rows that no longer
 * qualify. Never throws — a failed sweep is logged and retried next day,
 * leaving the previous day's counts in place.
 *
 * The ledger scan is cursor-paged rather than capped: a truncated sample
 * would deflate orgCount toward the floor and bias the ranking toward
 * whatever was deployed most recently.
 */
type LedgerScan = {
  events: AdoptionEvent[]
  agentIds: Set<string>
  flowIds: Set<string>
}

type LedgerPageRow = {
  organizationId: string
  resourceType: string | null
  resourceId: string | null
  context: unknown
}

/** Fold one ledger page into the running scan. Pure apart from the mutation. */
function accumulatePage(scan: LedgerScan, page: LedgerPageRow[]): void {
  for (const event of page) {
    const templateKey = templateKeyOfContext(event.context)
    if (!templateKey) continue
    scan.events.push({
      templateKey,
      organizationId: event.organizationId,
      resourceId: event.resourceId,
    })
    if (!event.resourceId) continue
    if (event.resourceType === 'agent') scan.agentIds.add(event.resourceId)
    if (event.resourceType === 'flow') scan.flowIds.add(event.resourceId)
  }
}

/**
 * Cursor-paged scan of the template_used window. Returns the adoption events
 * plus the deployed resource ids whose survival still needs checking.
 */
async function scanTemplateUseLedger(db: typeof systemPrisma, since: Date): Promise<LedgerScan> {
  const scan: LedgerScan = { events: [], agentIds: new Set(), flowIds: new Set() }

  let cursor: string | undefined
  for (;;) {
    const page = await db.userEvent.findMany({
      where: { kind: 'template_used', occurredAt: { gte: since } },
      // Cursor paging needs a stable total order; id is the primary key.
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        organizationId: true,
        resourceType: true,
        resourceId: true,
        context: true,
      },
    })
    if (page.length === 0) break
    accumulatePage(scan, page)
    if (page.length < PAGE_SIZE) break
    cursor = page[page.length - 1].id
  }
  return scan
}

export async function aggregateTemplateAdoption(
  db = systemPrisma,
  now = new Date(),
  minOrgs: number = MIN_ADOPTION_ORGS,
): Promise<{ templates: number } | { skipped: string }> {
  try {
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const { events, agentIds, flowIds } = await scanTemplateUseLedger(db, since)

    const [liveAgents, liveFlows] = await Promise.all([
      agentIds.size
        ? db.agentTask.findMany({
            where: { id: { in: [...agentIds] }, status: 'ACTIVE' },
            select: { id: true },
          })
        : Promise.resolve([]),
      flowIds.size
        ? db.flow.findMany({
            where: {
              id: { in: [...flowIds] },
              status: 'ACTIVE',
              publishedGraph: { not: undefined },
            },
            select: { id: true },
          })
        : Promise.resolve([]),
    ])
    const surviving = new Set([
      ...liveAgents.map((row) => row.id),
      ...liveFlows.map((row) => row.id),
    ])

    const rows = computeTemplateAdoption(events, surviving, minOrgs)
    for (const row of rows) {
      await db.templateAdoption.upsert({
        where: { templateKey: row.templateKey },
        create: row,
        update: {
          deploys: row.deploys,
          surviving: row.surviving,
          orgCount: row.orgCount,
        },
      })
    }
    // k-anonymity maintenance: anything not re-qualifying this sweep goes,
    // so a decayed template stops influencing rankings instead of lingering.
    await db.templateAdoption.deleteMany({
      where: {
        templateKey: { notIn: rows.length ? rows.map((row) => row.templateKey) : ['__none__'] },
      },
    })
    return { templates: rows.length }
  } catch (error) {
    apiLogger.warn('aggregateTemplateAdoption failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'templates.aggregate-adoption' })
    return { skipped: 'error' }
  }
}
