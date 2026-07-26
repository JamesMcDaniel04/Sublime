import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { bucketKeyFor, evaluateAndPersistGoal } from '@/lib/goals/refresh'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const idFrom = (pathname: string) =>
  decodeURIComponent(pathname.split('/').at(-2) ?? '')

async function visibleGoal(
  organizationId: string,
  userId: string,
  goalId: string,
) {
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId,
      OR: [{ ownerUserId: null }, { ownerUserId: userId }],
    },
    include: { metrics: { select: { id: true }, take: 1 } },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  const metric = goal.metrics[0]
  if (!metric) throw new ApiError('Goal metric not found', 409, 'METRIC_NOT_FOUND')
  return metric
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const goalId = idFrom(request.nextUrl.pathname)
  const metric = await visibleGoal(auth.organizationId, auth.dbUser.id, goalId)
  const datapoints = await prisma.metricDatapoint.findMany({
    where: { organizationId: auth.organizationId, goalMetricId: metric.id },
    orderBy: { capturedAt: 'asc' },
    take: 400,
    select: { id: true, value: true, capturedAt: true, origin: true },
  })
  return { success: true, datapoints }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const goalId = idFrom(request.nextUrl.pathname)
  const input = z
    .object({
      value: z.number().finite(),
      capturedAt: z.coerce.date().optional(),
    })
    .parse(await request.json().catch(() => ({})))
  const metric = await visibleGoal(auth.organizationId, auth.dbUser.id, goalId)
  const capturedAt = input.capturedAt ?? new Date()
  const datapoint = await prisma.metricDatapoint.upsert({
    where: {
      goalMetricId_bucketKey: {
        goalMetricId: metric.id,
        bucketKey: bucketKeyFor(capturedAt),
      },
      organizationId: auth.organizationId,
    },
    create: {
      organizationId: auth.organizationId,
      goalMetricId: metric.id,
      value: input.value,
      capturedAt,
      bucketKey: bucketKeyFor(capturedAt),
      origin: 'manual',
    },
    update: { value: input.value, capturedAt, origin: 'manual' },
    select: { id: true },
  })
  await evaluateAndPersistGoal(goalId, auth.organizationId)
  return { success: true, datapoint }
})
