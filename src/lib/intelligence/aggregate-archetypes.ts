/**
 * Platform-wide anonymized archetype aggregation (intelligence phase 3).
 *
 * Privacy model: the ONLY thing that crosses an org boundary is the
 * automation SHAPE — (sorted runtime providers, trigger type), both platform
 * vocabulary. No flow names, entities, org ids, or user ids are aggregated.
 * Rows are k-anonymous BY CONSTRUCTION: a shape is upserted only when
 * >= MIN_ARCHETYPE_ORGS distinct orgs share it, and stored rows falling below
 * the floor are deleted on the next sweep.
 *
 * Runs as a daily global cron sweep (systemPrisma: cross-tenant by design,
 * CRON_SECRET-gated at the route). Pure helpers carry the logic so the
 * k-anonymity contract is testable without a database.
 */
import { Prisma } from '@/generated/prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { groupProvidersByExecution } from '@/lib/behavior/mine-peer-practices'

/** k-anonymity floor: shapes shared by fewer orgs never surface anywhere. */
export const MIN_ARCHETYPE_ORGS = Math.max(2, Number(process.env.PLATFORM_ARCHETYPE_MIN_ORGS) || 5)
/** A shape is a real practice, not an experiment: >= 3 succeeded runs / 30d. */
export const MIN_SHAPE_RUNS = 3

const SWEEP_ORG_CAP = 500
const RUN_WINDOW_DAYS = 30

export type FlowShapeInput = {
  trigger: unknown
  /** Runtime providers the flow's succeeded runs touched (ledger-resolved). */
  providers: string[]
  successfulRuns: number
}

export type ArchetypeRow = {
  signature: string
  providers: string[]
  triggerType: string
  orgCount: number
  flowCount: number
}

const normalizeTrigger = (trigger: unknown): string => {
  const type = trigger && typeof trigger === 'object' && !Array.isArray(trigger) ? (trigger as { type?: unknown }).type : null
  return type === 'schedule' || type === 'signal' ? type : 'manual'
}

export const shapeSignature = (providers: string[], triggerType: string): string =>
  `${[...providers].sort().join('+')}:${triggerType}`

/** One org's automation shapes; each shape carries its qualifying flow count. */
export function computeOrgShapes(flows: FlowShapeInput[]): Map<string, { providers: string[]; triggerType: string; flowCount: number }> {
  const shapes = new Map<string, { providers: string[]; triggerType: string; flowCount: number }>()
  for (const flow of flows) {
    if (flow.successfulRuns < MIN_SHAPE_RUNS || flow.providers.length === 0) continue
    const triggerType = normalizeTrigger(flow.trigger)
    const providers = [...new Set(flow.providers)].sort()
    const signature = shapeSignature(providers, triggerType)
    const acc = shapes.get(signature)
    if (acc) acc.flowCount += 1
    else shapes.set(signature, { providers, triggerType, flowCount: 1 })
  }
  return shapes
}

/** Cross-org aggregation with the k-anonymity floor applied. */
export function aggregateShapes(orgShapes: Array<ReturnType<typeof computeOrgShapes>>): ArchetypeRow[] {
  const totals = new Map<string, ArchetypeRow>()
  for (const shapes of orgShapes) {
    for (const [signature, shape] of shapes) {
      const acc = totals.get(signature)
      if (acc) {
        acc.orgCount += 1
        acc.flowCount += shape.flowCount
      } else {
        totals.set(signature, { signature, providers: shape.providers, triggerType: shape.triggerType, orgCount: 1, flowCount: shape.flowCount })
      }
    }
  }
  return [...totals.values()].filter((row) => row.orgCount >= MIN_ARCHETYPE_ORGS)
}

/**
 * One org's shapes plus its touched-provider set, resolved from its flows,
 * succeeded runs, and tool_call ledger (the phase 2 executionId join — same
 * provider vocabulary as user events, no backfill). Shared by the sweep and
 * by the per-user archetype-gap loader.
 */
export async function computeShapesForOrg(
  organizationId: string,
  now: Date,
  db = systemPrisma,
): Promise<{ shapes: ReturnType<typeof computeOrgShapes>; orgProviders: Set<string> }> {
  const since = new Date(now.getTime() - RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const flows = await db.flow.findMany({
    where: { organizationId, OR: [{ status: 'ACTIVE' }, { NOT: { publishedGraph: { equals: Prisma.DbNull } } }] },
    select: { id: true, trigger: true },
    take: 100,
  })
  const [runs, toolEvents] = await Promise.all([
    flows.length
      ? db.flowRun.findMany({
          where: { organizationId, flowId: { in: flows.map((f) => f.id) }, status: 'succeeded', startedAt: { gte: since } },
          select: { id: true, flowId: true },
          take: 2000,
        })
      : [],
    db.userEvent.findMany({
      where: { organizationId, kind: 'tool_call', occurredAt: { gte: since } },
      select: { resourceId: true, context: true },
      take: 4000,
    }),
  ])
  const providersByExecution = groupProvidersByExecution(toolEvents)
  const byFlow = new Map<string, { providers: Set<string>; runs: number }>()
  for (const run of runs) {
    const acc = byFlow.get(run.flowId) ?? { providers: new Set<string>(), runs: 0 }
    acc.runs += 1
    for (const provider of providersByExecution.get(run.id) ?? []) acc.providers.add(provider)
    byFlow.set(run.flowId, acc)
  }
  const orgProviders = new Set<string>()
  for (const event of toolEvents) if (event.resourceId) orgProviders.add(event.resourceId)
  const shapes = computeOrgShapes(
    flows.map((flow) => {
      const acc = byFlow.get(flow.id)
      return { trigger: flow.trigger, providers: [...(acc?.providers ?? [])], successfulRuns: acc?.runs ?? 0 }
    }),
  )
  return { shapes, orgProviders }
}

/**
 * The dispatch cron ticks every 15 minutes, so exactly one tick lands in the
 * [04:00, 04:15) UTC window. Pure so the time gate is testable — the route
 * contains no window arithmetic of its own.
 */
export function shouldRunArchetypeSweep(now: Date): boolean {
  return now.getUTCHours() === 4 && now.getUTCMinutes() < 15
}

/**
 * The daily sweep: recompute every org's shapes, aggregate with the k-anon
 * floor, upsert qualifying rows, and delete rows that no longer qualify.
 * Never throws — a failed sweep is logged and retried next day.
 */
export async function aggregatePlatformArchetypes(db = systemPrisma, now = new Date()): Promise<{ archetypes: number } | { skipped: string }> {
  try {
    const orgs = await db.organization.findMany({ select: { id: true }, take: SWEEP_ORG_CAP })
    const orgShapes: Array<ReturnType<typeof computeOrgShapes>> = []
    for (const org of orgs) {
      try {
        orgShapes.push((await computeShapesForOrg(org.id, now, db)).shapes)
      } catch {
        // one broken org must not poison the sweep
      }
    }
    const rows = aggregateShapes(orgShapes)
    for (const row of rows) {
      await db.platformArchetype.upsert({
        where: { signature: row.signature },
        create: { signature: row.signature, providers: row.providers, triggerType: row.triggerType, orgCount: row.orgCount, flowCount: row.flowCount },
        update: { orgCount: row.orgCount, flowCount: row.flowCount, providers: row.providers },
      })
    }
    // k-anonymity maintenance: anything not re-qualifying this sweep goes.
    await db.platformArchetype.deleteMany({
      where: { signature: { notIn: rows.length ? rows.map((r) => r.signature) : ['__none__'] } },
    })
    return { archetypes: rows.length }
  } catch (error) {
    apiLogger.warn('aggregatePlatformArchetypes failed', { error: error instanceof Error ? error.message : String(error) })
    captureError(error, { scope: 'intelligence.archetypes' })
    return { skipped: 'error' }
  }
}
