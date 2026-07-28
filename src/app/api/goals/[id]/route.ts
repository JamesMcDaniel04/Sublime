import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { evaluateAndPersistGoal } from '@/lib/goals/refresh'
import { surfaceGoalBenchmark } from '@/lib/goals/aggregate-benchmarks'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseDashboardLayout } from '@/lib/goals/dashboard'
import { validateComposition, type CompositionState } from '@/lib/goals/composition'
import type { GoalKind } from '@/lib/goals/kind-migration'

export const runtime = 'nodejs'

const HOUR_MS = 60 * 60 * 1000
const RECURRENCES = ['monthly', 'quarterly', 'yearly'] as const
const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    targetValue: z.number().finite().optional(),
    targetDate: z.coerce.date().optional(),
    recurrence: z.enum(RECURRENCES).nullable().optional(),
    status: z.enum(['active', 'paused', 'achieved', 'missed']).optional(),
    dashboardLayout: z.unknown().optional(),
    composition: z.unknown().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No changes supplied.' })
  .refine((body) => body.targetDate === undefined || body.targetDate.getTime() > Date.now(), {
    message: 'Target date must be in the future.',
  })

const idFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-1) ?? '')
const visibleWhere = (organizationId: string, userId: string, id: string) => ({
  id,
  organizationId,
  OR: [{ ownerUserId: null }, { ownerUserId: userId }],
})

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const goal = await prisma.goal.findFirst({
    where: visibleWhere(auth.organizationId, auth.dbUser.id, id),
    include: {
      metrics: {
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        include: {
          datapoints: {
            orderBy: { capturedAt: 'desc' },
            take: 400,
            select: { id: true, value: true, capturedAt: true, origin: true },
          },
        },
      },
      periods: {
        orderBy: { periodEnd: 'desc' },
        take: 12,
        select: {
          periodStart: true,
          periodEnd: true,
          targetValue: true,
          finalValue: true,
          outcome: true,
        },
      },
    },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const metric =
    goal.metrics.find((candidate) => candidate.role === 'primary') ?? goal.metrics[0] ?? null
  const points = [...(metric?.datapoints ?? [])].reverse()
  const evaluation = evaluateGoal(
    { ...goal, direction: goal.direction as 'increase' | 'decrease' },
    points,
    new Date(),
    2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS,
  )
  // Deliberately NOT visibility-filtered: teammates' personal goals that
  // support this org goal appear counted-but-anonymized (masked below) —
  // "count it, never name it", same k-anon spirit as peer practices.
  const children = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      parentGoalId: id,
      status: { not: 'archived' },
    },
    select: { id: true, name: true, riskLevel: true, ownerUserId: true },
  })
  const benchmark = surfaceGoalBenchmark(
    await prisma.goalBenchmark.findUnique({
      where: { kind: goal.kind },
      select: {
        orgCount: true,
        settledCount: true,
        achievedCount: true,
        topSeedKeys: true,
      },
    }),
  )

  const openPlan = await prisma.goalRecoveryPlan.findFirst({
    where: { organizationId: auth.organizationId, goalId: id, status: 'open' },
    select: {
      id: true,
      triggerRiskLevel: true,
      diagnosis: true,
      evidence: true,
      createdAt: true,
      actions: {
        orderBy: { rank: 'asc' },
        select: {
          id: true,
          kind: true,
          title: true,
          rationale: true,
          payload: true,
          status: true,
          resultRef: true,
        },
      },
    },
  })

  return {
    success: true,
    goal: {
      id: goal.id,
      name: goal.name,
      description: goal.description,
      kind: goal.kind,
      direction: goal.direction,
      unit: goal.unit,
      startValue: goal.startValue,
      targetValue: goal.targetValue,
      startAt: goal.startAt,
      targetDate: goal.targetDate,
      recurrence: goal.recurrence,
      status: goal.status,
      riskLevel: goal.riskLevel,
      personal: goal.ownerUserId !== null,
      parentGoalId: goal.parentGoalId,
      currentValue: evaluation.currentValue,
      progress: evaluation.progress,
      expectedProgress: evaluation.expectedProgress,
      projectedValue: evaluation.projectedValue,
      dashboardLayout: goal.dashboardLayout ?? null,
      composition: goal.composition ?? null,
      // Written by evaluateAndPersistGoal; null for an uncomposed goal.
      compositionState: (goal.compositionState ?? null) as CompositionState | null,
      templateKey: goal.templateKey,
      metric: metric
        ? {
            id: metric.id,
            source: metric.source,
            metricKey: metric.metricKey,
            lastSyncAt: metric.lastSyncAt,
            lastError: metric.lastError,
          }
        : null,
      metrics: goal.metrics.map((series) => ({
        id: series.id,
        label: series.label,
        role: series.role as 'primary' | 'supporting' | 'component',
        slot: series.slot,
        unit: (series.unit ?? goal.unit) as 'usd' | 'count' | 'percent',
        source: series.source,
        metricKey: series.metricKey,
        lastSyncAt: series.lastSyncAt,
        lastError: series.lastError,
        datapoints: [...series.datapoints].reverse(),
      })),
      children: children.map((child) =>
        child.ownerUserId && child.ownerUserId !== auth.dbUser.id
          ? {
              id: null,
              name: 'A teammate’s goal',
              riskLevel: child.riskLevel,
              personal: true,
            }
          : {
              id: child.id,
              name: child.name,
              riskLevel: child.riskLevel,
              personal: child.ownerUserId !== null,
            },
      ),
      periods: goal.periods,
      benchmark,
      recoveryPlan: openPlan
        ? {
            id: openPlan.id,
            status: 'open' as const,
            triggerRiskLevel: openPlan.triggerRiskLevel,
            diagnosis: openPlan.diagnosis,
            evidence: Array.isArray(openPlan.evidence)
              ? (openPlan.evidence as string[])
              : [],
            createdAt: openPlan.createdAt,
            actions: openPlan.actions,
          }
        : null,
    },
  }
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const input = patchSchema.parse(await request.json().catch(() => ({})))
  const goal = await prisma.goal.findFirst({
    where: visibleWhere(auth.organizationId, auth.dbUser.id, id),
    select: { id: true, startValue: true, kind: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  if (input.targetValue !== undefined && input.targetValue === goal.startValue) {
    throw new ApiError('Target must differ from the baseline.', 400, 'INVALID_TARGET')
  }

  // Composition is validated against the slots ACTUALLY bound on this goal, not
  // against a client-supplied list: declaring a shape whose components do not
  // exist would leave the goal permanently gated with no way to see why.
  let compositionUpdate: Record<string, unknown> = {}
  if ('composition' in input && input.composition !== undefined) {
    if (input.composition === null) {
      compositionUpdate = { composition: null, compositionState: null }
    } else {
      const bound = await prisma.goalMetric.findMany({
        where: {
          organizationId: auth.organizationId,
          goalId: goal.id,
          role: 'component',
        },
        select: { slot: true },
      })
      const slots = bound
        .map((metric) => metric.slot)
        .filter((slot): slot is string => Boolean(slot))
      const message = validateComposition(goal.kind as GoalKind, input.composition, slots)
      if (message) throw new ApiError(message, 400, 'INVALID_COMPOSITION')
      compositionUpdate = { composition: input.composition }
    }
  }

  let layoutUpdate: Record<string, unknown> = {}
  if ('dashboardLayout' in input && input.dashboardLayout !== undefined) {
    if (input.dashboardLayout === null) {
      layoutUpdate = { dashboardLayout: null }
    } else {
      const layout = parseDashboardLayout(input.dashboardLayout)
      if (!layout) {
        throw new ApiError('Dashboard layout is not valid.', 400, 'INVALID_LAYOUT')
      }
      const owned = new Set(
        (
          await prisma.goalMetric.findMany({
            where: { organizationId: auth.organizationId, goalId: goal.id },
            select: { id: true },
          })
        ).map((metric) => metric.id),
      )
      const referenced = layout.widgets
        .flatMap((widget) => {
          const config = widget.config
          return [
            config.metricId,
            config.numeratorId,
            config.denominatorId,
            ...((config.metricIds as string[] | undefined) ?? []),
          ]
        })
        .filter((value): value is string => typeof value === 'string')
      if (referenced.some((metricId) => !owned.has(metricId))) {
        throw new ApiError(
          'Layout references a metric that is not on this goal.',
          400,
          'INVALID_LAYOUT',
        )
      }
      layoutUpdate = { dashboardLayout: layout as never }
    }
  }
  const { dashboardLayout, composition, ...rest } = input
  void dashboardLayout
  void composition
  await prisma.goal.update({
    where: { id: goal.id, organizationId: auth.organizationId },
    data: { ...rest, ...layoutUpdate, ...compositionUpdate },
  })
  // Re-evaluate when the target moved or the goal was un-paused — the cron
  // sweep skips paused goals, so without this the badge stays stale until the
  // next tick after resume.
  if (
    input.targetValue !== undefined ||
    input.targetDate !== undefined ||
    input.recurrence !== undefined ||
    input.status === 'active'
  ) {
    await evaluateAndPersistGoal(goal.id, auth.organizationId)
  }
  return { success: true }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const goal = await prisma.goal.findFirst({
    where: visibleWhere(auth.organizationId, auth.dbUser.id, id),
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  await prisma.goal.update({
    where: { id: goal.id, organizationId: auth.organizationId },
    data: { status: 'archived' },
  })
  return { success: true }
})
