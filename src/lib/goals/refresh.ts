/**
 * Goal metric freshness + evaluation. Runs inside every /api/cron/dispatch
 * tick; per-metric throttling supplies the real cadence. Fetch failures land
 * on GoalMetric.lastError and never fail the tick.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { getMetricSource } from '@/lib/metrics/registry'
import type { MetricReading, MetricSourceContext } from '@/lib/metrics/types'
import { evaluateGoal, settleStatus, type Evaluation } from './evaluate'
import { emitGoalRecommendation } from './emit-recommendation'

const MAX_METRICS_PER_TICK = 200
const EVAL_WINDOW_POINTS = 400
const HOUR_MS = 60 * 60 * 1000

export function bucketKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10)
}

type FetchReading = (
  source: string,
  ctx: MetricSourceContext,
  metricKey: string,
) => Promise<MetricReading>

const defaultFetch: FetchReading = (source, ctx, metricKey) => {
  const adapter = getMetricSource(source)
  if (!adapter) throw new Error(`No metric source registered for '${source}'`)
  return adapter.fetchValue(ctx, metricKey)
}

export async function refreshGoalMetrics(
  now: Date = new Date(),
  deps: { fetchReading?: FetchReading } = {},
): Promise<{ due: number; refreshed: number; failed: number; transitions: number }> {
  const fetchReading = deps.fetchReading ?? defaultFetch

  // systemPrisma: cross-org metric sweep, driven by the CRON_SECRET-gated tick.
  const due = await systemPrisma.goalMetric.findMany({
    where: {
      source: { not: 'manual' },
      goal: { status: 'active' },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - HOUR_MS) } }],
    },
    select: {
      id: true,
      organizationId: true,
      goalId: true,
      source: true,
      metricKey: true,
      connectionRef: true,
      config: true,
      refreshIntervalHours: true,
      lastSyncAt: true,
      goal: { select: { ownerUserId: true, createdByUserId: true } },
    },
    take: MAX_METRICS_PER_TICK,
  })

  let refreshed = 0
  let failed = 0
  let transitions = 0
  for (const metric of due) {
    if (
      metric.lastSyncAt &&
      now.getTime() - metric.lastSyncAt.getTime() <
        metric.refreshIntervalHours * HOUR_MS
    ) {
      continue
    }
    try {
      const reading = await fetchReading(
        metric.source,
        {
          organizationId: metric.organizationId,
          userId: metric.goal.ownerUserId ?? metric.goal.createdByUserId ?? undefined,
          connectionRef: metric.connectionRef,
          config: (metric.config ?? {}) as Record<string, unknown>,
        },
        metric.metricKey,
      )
      await prisma.metricDatapoint.upsert({
        where: {
          goalMetricId_bucketKey: {
            goalMetricId: metric.id,
            bucketKey: bucketKeyFor(reading.asOf),
          },
          organizationId: metric.organizationId,
        },
        create: {
          organizationId: metric.organizationId,
          goalMetricId: metric.id,
          value: reading.value,
          capturedAt: reading.asOf,
          bucketKey: bucketKeyFor(reading.asOf),
          origin: 'sync',
        },
        update: { value: reading.value, capturedAt: reading.asOf },
      })
      await prisma.goalMetric.update({
        where: { id: metric.id, organizationId: metric.organizationId },
        data: { lastSyncAt: now, lastError: null },
      })
      refreshed += 1
    } catch (error) {
      failed += 1
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      await prisma.goalMetric
        .update({
          where: { id: metric.id, organizationId: metric.organizationId },
          data: { lastSyncAt: now, lastError: message },
        })
        .catch(() => undefined)
      apiLogger.warn('goals.refresh: metric fetch failed', {
        goalMetricId: metric.id,
        source: metric.source,
        error: message,
      })
    }
    const changed = await evaluateAndPersistGoal(metric.goalId, metric.organizationId, now)
    if (changed) transitions += 1
  }
  return { due: due.length, refreshed, failed, transitions }
}

/** Re-evaluate one goal; persist risk/status; emit only on a worsening
 * transition. Exported for the manual datapoint route. */
export async function evaluateAndPersistGoal(
  goalId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId },
    include: {
      metrics: { select: { id: true, refreshIntervalHours: true, lastError: true } },
    },
  })
  if (!goal || goal.status === 'archived' || goal.status === 'paused') return false
  const metric = goal.metrics[0]
  const descending = metric
    ? await prisma.metricDatapoint.findMany({
        where: { organizationId, goalMetricId: metric.id },
        orderBy: { capturedAt: 'desc' },
        take: EVAL_WINDOW_POINTS,
        select: { value: true, capturedAt: true },
      })
    : []
  const points = descending.reverse()
  const staleAfterMs = 2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS
  const evaluated = evaluateGoal(
    {
      ...goal,
      direction: goal.direction as 'increase' | 'decrease',
    },
    points,
    now,
    staleAfterMs,
  )
  // A source failure is itself a no-data signal even when an older reading is
  // still inside its freshness window.
  const evaluation: Evaluation = metric?.lastError
    ? { ...evaluated, riskLevel: 'no_data' }
    : evaluated
  const settled = settleStatus(
    { ...goal, direction: goal.direction as 'increase' | 'decrease' },
    evaluation,
    now,
  )

  const changed = evaluation.riskLevel !== goal.riskLevel
  await prisma.goal.update({
    where: { id: goal.id, organizationId },
    data: {
      riskLevel: evaluation.riskLevel,
      lastEvaluatedAt: now,
      ...(settled && goal.status === 'active' ? { status: settled } : {}),
    },
  })

  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (settled === 'achieved' && goal.status === 'active' && recipient) {
    await recordUserEvent({
      organizationId,
      userId: recipient,
      kind: 'goal_achieved',
      resourceType: 'goal',
      resourceId: goal.id,
    })
  }
  const worsened =
    changed &&
    (evaluation.riskLevel === 'at_risk' || evaluation.riskLevel === 'off_track')
  if (worsened && goal.status === 'active' && !settled) {
    await emitGoalRecommendation(goal, evaluation)
    if (recipient) {
      await recordUserEvent({
        organizationId,
        userId: recipient,
        kind: 'goal_off_track',
        resourceType: 'goal',
        resourceId: goal.id,
        context: { riskLevel: evaluation.riskLevel },
      })
    }
  }
  return changed
}
