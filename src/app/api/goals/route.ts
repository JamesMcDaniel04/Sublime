import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { bucketKeyFor } from '@/lib/goals/refresh'
import { validateReadOnlyQuery } from '@/lib/metrics/sources/postgres'
import { assertSafeUrl } from '@/lib/metrics/sources/url'
import { GOAL_KIND_UNITS } from '@/lib/types'
import { GOAL_KIND_VALUES } from '@/lib/goals/kind-migration'
import { parseDraftLayout, resolveLayoutMetricRefs } from '@/lib/goals/dashboard'
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'

export const runtime = 'nodejs'

const GOAL_KINDS = GOAL_KIND_VALUES
const RECURRENCES = ['monthly', 'quarterly', 'yearly'] as const
const HOUR_MS = 60 * 60 * 1000
const SPARKLINE_POINTS = 30

const metricInputSchema = z.object({
  source: z.enum(METRIC_SOURCES),
  metricKey: z.string().min(1),
  connectionRef: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})
const metricListItemSchema = metricInputSchema.extend({
  label: z.string().min(1).max(80),
  role: z.enum(['primary', 'supporting']),
  unit: z.enum(['usd', 'count', 'percent']).optional(),
})
const metricListOf = (body: {
  metric?: z.infer<typeof metricInputSchema>
  metrics?: z.infer<typeof metricListItemSchema>[]
}) =>
  body.metrics ??
  (body.metric
    ? [{ ...body.metric, label: null as string | null, role: 'primary' as const, unit: undefined }]
    : [])

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
    metric: metricInputSchema.optional(),
    metrics: z.array(metricListItemSchema).min(1).max(4).optional(),
    dashboardLayout: z.unknown().optional(),
    templateKey: z.string().max(120).optional(),
  })
  .refine((body) => (body.metric !== undefined) !== (body.metrics !== undefined), {
    message: 'Provide metric or metrics, not both.',
  })
  .refine(
    (body) =>
      !body.metrics ||
      body.metrics.filter((metric) => metric.role === 'primary').length === 1,
    { message: 'Exactly one metric must be primary.' },
  )
  .refine((body) => body.targetValue !== body.startValue, {
    message: 'Target must differ from the baseline.',
  })
  .refine((body) => body.targetDate.getTime() > Date.now(), {
    message: 'Target date must be in the future.',
  })
  .refine(
    (body) =>
      metricListOf(body).every(
        (metric) => NO_CONNECTION_SOURCES.has(metric.source) || Boolean(metric.connectionRef),
      ),
    { message: 'Pick the connection this metric reads from.' },
  )
  // Per-source config validation at creation — a direct POST that skipped
  // the wizard preview should fail here, not surface as lastError on the
  // first tick.
  .superRefine((body, ctx) => {
    for (const [index, metric] of metricListOf(body).entries()) {
      const issue = (path: string, message: string) =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: body.metrics
            ? ['metrics', index, 'config', path]
            : ['metric', 'config', path],
          message,
        })
      const { source, config } = metric
      if (source === 'postgres') {
        try {
          validateReadOnlyQuery(typeof config.query === 'string' ? config.query : '')
        } catch (error) {
          issue('query', error instanceof Error ? error.message : 'Invalid Postgres query.')
        }
      }
      if (source === 'url') {
        try {
          assertSafeUrl(typeof config.url === 'string' ? config.url : '')
        } catch (error) {
          issue('url', error instanceof Error ? error.message : 'Invalid URL.')
        }
      }
      if (
        source === 'slack_assisted' &&
        !(typeof config.channel === 'string' && config.channel.trim())
      ) {
        issue('channel', 'Pick the Slack channel that reports this number.')
      }
      if (
        source === 'gmail_assisted' &&
        !(typeof config.query === 'string' && config.query.trim())
      ) {
        issue('query', 'Enter the Gmail search that finds the report emails.')
      }
    }
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
        where: { role: 'primary' },
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

  const metricList = input.metrics ?? [
    { ...input.metric!, label: null, role: 'primary' as const, unit: undefined },
  ]
  const draftLayout =
    input.dashboardLayout === undefined
      ? null
      : parseDraftLayout(input.dashboardLayout, metricList.length)
  if (input.dashboardLayout !== undefined && draftLayout === null) {
    throw new ApiError('Dashboard layout is not valid.', 400, 'INVALID_LAYOUT')
  }

  const now = new Date()
  const goal = await prisma.$transaction(async (tx) => {
    const created = await tx.goal.create({
      data: {
        organizationId: auth.organizationId,
        ownerUserId: input.personal ? auth.dbUser.id : null,
        parentGoalId: input.parentGoalId ?? null,
        templateKey: input.templateKey ?? null,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        direction: input.direction,
        // The kind implies the unit — client input is honored only for
        // custom_kpi, so the invariant holds even for direct API callers.
        unit: GOAL_KIND_UNITS[input.kind] ?? input.unit,
        startValue: input.startValue,
        targetValue: input.targetValue,
        targetDate: input.targetDate,
        recurrence: input.recurrence,
        createdByUserId: auth.dbUser.id,
      },
    })
    const metricIds: string[] = []
    for (const metric of metricList) {
      const row = await tx.goalMetric.create({
        data: {
          organizationId: auth.organizationId,
          goalId: created.id,
          role: metric.role,
          label: metric.label,
          unit: metric.role === 'primary' ? null : (metric.unit ?? null),
          source: metric.source,
          metricKey: metric.metricKey,
          connectionRef: NO_CONNECTION_SOURCES.has(metric.source)
            ? null
            : (metric.connectionRef ?? null),
          config: metric.config as never,
        },
      })
      metricIds.push(row.id)
    }
    const primaryIndex = metricList.findIndex((metric) => metric.role === 'primary')
    const primaryId = metricIds[primaryIndex]
    await tx.metricDatapoint.create({
      data: {
        organizationId: auth.organizationId,
        goalMetricId: primaryId,
        value: input.startValue,
        capturedAt: now,
        bucketKey: bucketKeyFor(now),
        origin: 'backfill',
      },
    })
    if (draftLayout) {
      await tx.goal.update({
        where: { id: created.id, organizationId: auth.organizationId },
        data: { dashboardLayout: resolveLayoutMetricRefs(draftLayout, metricIds) as never },
      })
    }
    return created
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
