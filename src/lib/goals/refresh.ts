/**
 * Goal metric freshness + evaluation. Runs inside every /api/cron/dispatch
 * tick; per-metric throttling supplies the real cadence. Fetch failures land
 * on GoalMetric.lastError and never fail the tick.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { notify } from '@/lib/notifications/service'
import { getMetricSource } from '@/lib/metrics/registry'
import type { MetricReading, MetricSourceContext } from '@/lib/metrics/types'
import { evaluateGoal, settleStatus, type Evaluation } from './evaluate'
import { emitGoalRecommendation } from './emit-recommendation'
import { addPeriod, type GoalRecurrence } from './recurrence'

const MAX_METRICS_PER_TICK = 200
const EVAL_WINDOW_POINTS = 400
const HOUR_MS = 60 * 60 * 1000
/** Rollover catch-up bound per evaluation: two years of monthly windows —
 *  a staler goal resumes catching up on the next tick. */
const MAX_CATCHUP_WINDOWS = 24

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
  const foundGoal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId },
    include: {
      metrics: { select: { id: true, refreshIntervalHours: true, lastError: true } },
    },
  })
  if (!foundGoal || foundGoal.status === 'archived' || foundGoal.status === 'paused') return false
  let goal = foundGoal
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
  let rolledOver = false

  // A recurring Goal row advances in place. Each elapsed window settles in
  // its own transaction so a crash can resume from the still-expired
  // targetDate without creating a half-advanced period. The loop is capped:
  // a years-stale goal catches up MAX_CATCHUP_WINDOWS windows per evaluation
  // and resumes on the next tick, and only the FINAL settlement notifies —
  // a catch-up must not fire dozens of notifications in one tick.
  let catchupWindows = 0
  let lastSettlement: { outcome: string; periodEnd: Date; finalValue: number } | null = null
  while (
    goal.recurrence &&
    goal.status === 'active' &&
    now.getTime() > goal.targetDate.getTime() &&
    catchupWindows < MAX_CATCHUP_WINDOWS
  ) {
    catchupWindows += 1
    const recurrence = goal.recurrence as GoalRecurrence
    // Half-open window [startAt, targetDate): a boundary reading belongs to
    // the NEXT window, never to both.
    const inWindow = points.filter(
      (point) =>
        point.capturedAt.getTime() >= goal.startAt.getTime() &&
        point.capturedAt.getTime() < goal.targetDate.getTime(),
    )
    const hadReadings = inWindow.length > 0
    const finalValue: number = inWindow.at(-1)?.value ?? goal.startValue
    // An empty window settles 'missed' regardless of the carried level: with
    // zero evidence in the window, repeating 'achieved' from a stale carried
    // value would fabricate wins (spec: later empty windows settle missed).
    const outcome = !hadReadings
      ? 'missed'
      : goal.direction === 'decrease'
        ? finalValue <= goal.targetValue
          ? 'achieved'
          : 'missed'
        : finalValue >= goal.targetValue
          ? 'achieved'
          : 'missed'
    const periodStart = goal.startAt
    const periodEnd: Date = goal.targetDate
    const nextTargetDate = addPeriod(periodEnd, recurrence)
    const nextPoints = [
      { value: finalValue, capturedAt: periodEnd },
      ...points.filter(
        (point) =>
          point.capturedAt.getTime() >= periodEnd.getTime() &&
          point.capturedAt.getTime() < nextTargetDate.getTime(),
      ),
    ]
    const nextEvaluation = evaluateGoal(
      {
        ...goal,
        startAt: periodEnd,
        targetDate: nextTargetDate,
        startValue: finalValue,
        direction: goal.direction as 'increase' | 'decrease',
      },
      nextPoints,
      now,
      staleAfterMs,
    )

    await prisma.$transaction(async (tx) => {
      await tx.goalPeriod.create({
        data: {
          organizationId,
          goalId: goal.id,
          periodStart,
          periodEnd,
          startValue: goal.startValue,
          targetValue: goal.targetValue,
          finalValue,
          outcome,
        },
      })
      await tx.goal.update({
        where: { id: goal.id, organizationId },
        data: {
          startAt: periodEnd,
          targetDate: nextTargetDate,
          startValue: finalValue,
          status: 'active',
          riskLevel: nextEvaluation.riskLevel,
          lastEvaluatedAt: now,
        },
      })
    })

    lastSettlement = { outcome, periodEnd, finalValue }
    goal = {
      ...goal,
      startAt: periodEnd,
      targetDate: nextTargetDate,
      startValue: finalValue,
      riskLevel: nextEvaluation.riskLevel,
      lastEvaluatedAt: now,
    }
    rolledOver = true
  }

  // Single settlement notification per evaluation, for the most recent
  // window only — a multi-window catch-up reports once, not per window.
  if (lastSettlement) {
    const recipient = goal.ownerUserId ?? goal.createdByUserId
    if (recipient) {
      await recordUserEvent({
        organizationId,
        userId: recipient,
        kind: lastSettlement.outcome === 'achieved' ? 'goal_achieved' : 'goal_off_track',
        resourceType: 'goal',
        resourceId: goal.id,
        context: {
          periodEnd: lastSettlement.periodEnd.toISOString(),
          outcome: lastSettlement.outcome,
          catchupWindows,
        },
      })
    }
    await notify({
      organizationId,
      ...(goal.ownerUserId ? { userId: goal.ownerUserId } : {}),
      type: 'goal.period',
      level: lastSettlement.outcome === 'achieved' ? 'success' : 'action',
      title: `${goal.name}: ${lastSettlement.outcome === 'achieved' ? 'achieved ✓' : 'missed'}`,
      // UTC date + pinned locale: the server's timezone must not shift the
      // reported period boundary.
      body: `The period ending ${lastSettlement.periodEnd.toISOString().slice(0, 10)} settled at ${lastSettlement.finalValue.toLocaleString('en-US')} against a ${goal.targetValue.toLocaleString('en-US')} target${catchupWindows > 1 ? ` (${catchupWindows} windows caught up)` : ''}.`,
      executionId: goal.id,
      link: `/goals/${goal.id}`,
    })
  }

  const evaluationPoints = goal.recurrence
    ? [
        { value: goal.startValue, capturedAt: goal.startAt },
        ...points.filter((point) => point.capturedAt.getTime() > goal.startAt.getTime()),
      ]
    : points
  const evaluated = evaluateGoal(
    {
      ...goal,
      direction: goal.direction as 'increase' | 'decrease',
    },
    evaluationPoints,
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
  return changed || rolledOver
}
