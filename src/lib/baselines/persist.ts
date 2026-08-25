/**
 * The one DB-touching step in the baselines module. Everything it depends on is
 * pure and separately tested; this file only reads rows, calls those functions,
 * and writes results.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { computeBaselines } from './compute'
import { HANDLING_TIME_TABLE_VERSION, resolveHandlingMinutes } from './handling-time'
import { projectBaseline } from './project'
import type { BaselineEvent } from './types'

/** Injectable seam for tests, mirroring ActivityDb in the activity ledger. */
export type BaselineDb = Pick<typeof prisma, 'activityEvent' | 'processBaseline' | 'organization'>

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Ceiling on rows pulled per recompute; keeps a large org's pass bounded. */
const MAX_EVENTS = 50_000
/** The invariant needs evidence, not exhaustive evidence — an unbounded edge
 *  list per baseline would bloat the graph for no added traceability. */
const MAX_EVIDENCE_PER_BASELINE = 25

/**
 * Coverage ACTUALLY observed, not the window requested. A backfill that
 * returned 40 days of a 90-day request must report 40 — overstating coverage
 * would inflate confidence on history that was never read.
 */
export function observedWindowDays(events: { occurredAt: Date }[], now: Date): number {
  if (events.length === 0) return 0
  let earliest = events[0].occurredAt.getTime()
  for (const event of events) {
    const time = event.occurredAt.getTime()
    if (time < earliest) earliest = time
  }
  const days = (now.getTime() - earliest) / MS_PER_DAY
  return Math.max(1, Math.round(days))
}

export async function recomputeOrgBaselines(
  organizationId: string,
  opts: { now?: Date; db?: BaselineDb } = {},
): Promise<{ baselines: number; events: number }> {
  const db = opts.db ?? prisma
  const now = opts.now ?? new Date()

  const rows = await db.activityEvent.findMany({
    where: { organizationId },
    select: {
      id: true,
      source: true,
      action: true,
      entityType: true,
      entityRef: true,
      actorRef: true,
      occurredAt: true,
      previousState: true,
      newState: true,
    },
    orderBy: { occurredAt: 'asc' },
    take: MAX_EVENTS,
  })
  if (rows.length === 0) return { baselines: 0, events: 0 }

  const events = rows as (BaselineEvent & { id: string })[]
  const windowDays = observedWindowDays(events, now)
  const baselines = computeBaselines(events, windowDays)

  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } })
  const settings = org?.settings ?? {}

  for (const baseline of baselines) {
    const handlingMinutes = resolveHandlingMinutes(baseline.action, settings)
    const values = {
      volume: baseline.volume,
      windowDays: baseline.windowDays,
      periodDays: baseline.periodDays,
      distinctActors: baseline.distinctActors,
      medianCycleTimeHours: baseline.medianCycleTimeHours,
      reworkRate: baseline.reworkRate,
      confidence: baseline.confidence,
      handlingTimeTableVersion: HANDLING_TIME_TABLE_VERSION,
      handlingMinutes,
      computedAt: now,
    }
    await db.processBaseline.upsert({
      where: {
        organizationId_source_action_entityType: {
          organizationId,
          source: baseline.source,
          action: baseline.action,
          entityType: baseline.entityType,
        },
      },
      create: {
        organizationId,
        source: baseline.source,
        action: baseline.action,
        entityType: baseline.entityType,
        ...values,
      },
      update: values,
    })

    const evidenceEventIds = events
      .filter(
        (event) =>
          event.source === baseline.source &&
          event.action === baseline.action &&
          event.entityType === baseline.entityType,
      )
      .slice(0, MAX_EVIDENCE_PER_BASELINE)
      .map((event) => event.id)
    await projectBaseline(organizationId, baseline, evidenceEventIds)
  }

  apiLogger.info('baselines: recomputed', {
    organizationId,
    baselines: baselines.length,
    events: events.length,
    windowDays,
  })
  return { baselines: baselines.length, events: events.length }
}
