import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { evaluateAndPersistGoal } from '@/lib/goals/refresh'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const HOUR_MS = 60 * 60 * 1000
const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    targetValue: z.number().finite().optional(),
    targetDate: z.coerce.date().optional(),
    status: z.enum(['active', 'paused', 'achieved', 'missed']).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'No changes supplied.' })

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
        include: {
          datapoints: {
            orderBy: { capturedAt: 'desc' },
            take: 400,
            select: { value: true, capturedAt: true, origin: true },
          },
        },
      },
    },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const metric = goal.metrics[0] ?? null
  const points = [...(metric?.datapoints ?? [])].reverse()
  const evaluation = evaluateGoal(
    { ...goal, direction: goal.direction as 'increase' | 'decrease' },
    points,
    new Date(),
    2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS,
  )
  const children = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      parentGoalId: id,
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    select: { id: true, name: true, riskLevel: true, ownerUserId: true },
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
      status: goal.status,
      riskLevel: goal.riskLevel,
      personal: goal.ownerUserId !== null,
      parentGoalId: goal.parentGoalId,
      currentValue: evaluation.currentValue,
      progress: evaluation.progress,
      expectedProgress: evaluation.expectedProgress,
      projectedValue: evaluation.projectedValue,
      metric: metric
        ? {
            id: metric.id,
            source: metric.source,
            metricKey: metric.metricKey,
            lastSyncAt: metric.lastSyncAt,
            lastError: metric.lastError,
          }
        : null,
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
    },
  }
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request.nextUrl.pathname)
  const input = patchSchema.parse(await request.json().catch(() => ({})))
  const goal = await prisma.goal.findFirst({
    where: visibleWhere(auth.organizationId, auth.dbUser.id, id),
    select: { id: true, startValue: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  if (input.targetValue !== undefined && input.targetValue === goal.startValue) {
    throw new ApiError('Target must differ from the baseline.', 400, 'INVALID_TARGET')
  }

  await prisma.goal.update({
    where: { id: goal.id, organizationId: auth.organizationId },
    data: input,
  })
  if (input.targetValue !== undefined || input.targetDate !== undefined) {
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
