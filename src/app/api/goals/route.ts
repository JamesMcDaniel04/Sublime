import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { bucketKeyFor } from '@/lib/goals/refresh'

export const runtime = 'nodejs'

const GOAL_KINDS = [
  'arr',
  'mrr',
  'carr',
  'revenue',
  'quota',
  'savings',
  'custom_kpi',
] as const
const METRIC_SOURCES = [
  'stripe',
  'hubspot',
  'salesforce',
  'google_sheets',
  'postgres',
  'manual',
] as const
const RECURRENCES = ['monthly', 'quarterly', 'yearly'] as const
const HOUR_MS = 60 * 60 * 1000
const SPARKLINE_POINTS = 30

const createSchema = z
  .object({
    name: z.string().min(1, 'Name the goal.').max(120),
    description: z.string().max(2000).optional(),
    kind: z.enum(GOAL_KINDS),
    direction: z.enum(['increase', 'decrease']).default('increase'),
    unit: z.enum(['usd', 'count', 'percent']).default('usd'),
    startValue: z.number().finite(),
    targetValue: z.number().finite(),
    targetDate: z.coerce.date(),
    recurrence: z.enum(RECURRENCES).nullable().default(null),
    personal: z.boolean().default(false),
    parentGoalId: z.string().optional(),
    metric: z.object({
      source: z.enum(METRIC_SOURCES),
      metricKey: z.string().min(1),
      connectionRef: z.string().nullable().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  })
  .refine((body) => body.targetValue !== body.startValue, {
    message: 'Target must differ from the baseline.',
  })
  .refine((body) => body.targetDate.getTime() > Date.now(), {
    message: 'Target date must be in the future.',
  })
  .refine((body) => body.metric.source === 'manual' || Boolean(body.metric.connectionRef), {
    message: 'Pick the connection this metric reads from.',
  })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const goals = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      status: { not: 'archived' },
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    orderBy: [{ ownerUserId: 'asc' }, { createdAt: 'desc' }],
    include: {
      metrics: {
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: {
          source: true,
          metricKey: true,
          lastSyncAt: true,
          lastError: true,
          refreshIntervalHours: true,
          datapoints: {
            orderBy: { capturedAt: 'desc' },
            take: SPARKLINE_POINTS,
            select: { value: true, capturedAt: true },
          },
        },
      },
    },
  })
  const now = new Date()
  return {
    success: true,
    goals: goals.map((goal) => {
      const metric = goal.metrics[0] ?? null
      const points = [...(metric?.datapoints ?? [])].reverse()
      const staleAfterMs = 2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS
      const evaluation = evaluateGoal(
        { ...goal, direction: goal.direction as 'increase' | 'decrease' },
        points,
        now,
        staleAfterMs,
      )
      return {
        id: goal.id,
        name: goal.name,
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
        metric: metric
          ? {
              source: metric.source,
              metricKey: metric.metricKey,
              lastSyncAt: metric.lastSyncAt,
              lastError: metric.lastError,
            }
          : null,
        currentValue: evaluation.currentValue,
        progress: evaluation.progress,
        expectedProgress: evaluation.expectedProgress,
        sparkline: points,
      }
    }),
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = createSchema.parse(await request.json().catch(() => ({})))

  if (input.parentGoalId) {
    if (!input.personal) {
      throw new ApiError(
        'Only personal goals can support an organization goal.',
        400,
        'INVALID_PARENT',
      )
    }
    const parent = await prisma.goal.findFirst({
      where: {
        id: input.parentGoalId,
        organizationId: auth.organizationId,
        ownerUserId: null,
      },
      select: { id: true },
    })
    if (!parent) throw new ApiError('Linked org goal not found.', 404, 'PARENT_NOT_FOUND')
  }

  const now = new Date()
  const goal = await prisma.goal.create({
    data: {
      organizationId: auth.organizationId,
      ownerUserId: input.personal ? auth.dbUser.id : null,
      parentGoalId: input.parentGoalId ?? null,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      direction: input.direction,
      unit: input.unit,
      startValue: input.startValue,
      targetValue: input.targetValue,
      targetDate: input.targetDate,
      recurrence: input.recurrence,
      createdByUserId: auth.dbUser.id,
      metrics: {
        create: {
          organizationId: auth.organizationId,
          source: input.metric.source,
          metricKey: input.metric.metricKey,
          connectionRef: input.metric.connectionRef ?? null,
          config: input.metric.config as never,
        },
      },
    },
    include: { metrics: { select: { id: true } } },
  })

  await prisma.metricDatapoint.create({
    data: {
      organizationId: auth.organizationId,
      goalMetricId: goal.metrics[0].id,
      value: input.startValue,
      capturedAt: now,
      bucketKey: bucketKeyFor(now),
      origin: 'backfill',
    },
  })
  await recordUserEvent({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    kind: 'goal_created',
    resourceType: 'goal',
    resourceId: goal.id,
    context: { kind: input.kind, personal: input.personal },
  })
  return { success: true, goal: { id: goal.id } }
})
