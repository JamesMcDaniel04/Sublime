import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const bodySchema = z.object({ op: z.literal('dismiss') })

/** pathname: /api/goals/<id>/recovery */
const goalIdFrom = (pathname: string) =>
  decodeURIComponent(pathname.split('/').at(-2) ?? '')

export const POST = withAuthenticatedApi(async (request, auth) => {
  bodySchema.parse(await request.json().catch(() => ({})))
  const goalId = goalIdFrom(request.nextUrl.pathname)
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId: auth.organizationId,
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const dismissed = await prisma.goalRecoveryPlan.updateMany({
    where: { organizationId: auth.organizationId, goalId, status: 'open' },
    data: { status: 'dismissed' },
  })
  // A dismissed plan must not leave an open pointer suggestion behind — an
  // open goal_action suggestion permanently mutes the goal's future
  // fallback recommendations.
  if (dismissed.count > 0) {
    await prisma.userSuggestion.updateMany({
      where: {
        organizationId: auth.organizationId,
        kind: 'goal_action',
        status: 'open',
        targetType: 'goal',
        targetId: goalId,
      },
      data: { status: 'dismissed' },
    })
  }
  return { success: true, dismissed: dismissed.count }
})
