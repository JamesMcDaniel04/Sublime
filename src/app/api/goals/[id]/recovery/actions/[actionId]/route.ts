import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const bodySchema = z.object({ op: z.enum(['accept', 'dismiss']) })

/** pathname: /api/goals/<id>/recovery/actions/<actionId> */
function idsFrom(pathname: string): { goalId: string; actionId: string } {
  const segments = pathname.split('/')
  return {
    goalId: decodeURIComponent(segments.at(-4) ?? ''),
    actionId: decodeURIComponent(segments.at(-1) ?? ''),
  }
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { op } = bodySchema.parse(await request.json().catch(() => ({})))
  const { goalId, actionId } = idsFrom(request.nextUrl.pathname)

  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId: auth.organizationId,
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const action = await prisma.goalRecoveryAction.findFirst({
    where: {
      id: actionId,
      organizationId: auth.organizationId,
      plan: { goalId, organizationId: auth.organizationId, status: 'open' },
    },
    select: { id: true, kind: true, status: true, payload: true },
  })
  if (!action) throw new ApiError('Recovery action not found', 404, 'RECOVERY_ACTION_NOT_FOUND')

  if (op === 'dismiss') {
    await prisma.goalRecoveryAction.update({
      where: { id: action.id, organizationId: auth.organizationId },
      data: { status: 'dismissed' },
    })
    return { success: true, status: 'dismissed' as const }
  }

  // accept — per-kind behavior. manual_step completes immediately;
  // connect_tool sends the user to /integrations (Task-5 reconcile observes
  // the actual connection); launch_agent hands the client a provision body —
  // the provision route marks the action done server-side, so a crashed
  // client leaves it 'accepted' (retryable), never falsely 'done'.
  if (action.kind === 'manual_step') {
    await prisma.goalRecoveryAction.update({
      where: { id: action.id, organizationId: auth.organizationId },
      data: { status: 'done', acceptedAt: new Date() },
    })
    return { success: true, status: 'done' as const }
  }

  await prisma.goalRecoveryAction.update({
    where: { id: action.id, organizationId: auth.organizationId },
    data: { status: 'accepted', acceptedAt: new Date() },
  })
  if (action.kind === 'connect_tool') {
    return { success: true, status: 'accepted' as const, href: '/integrations' }
  }
  const payload =
    action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
      ? (action.payload as Record<string, unknown>)
      : {}
  return {
    success: true,
    status: 'accepted' as const,
    provision: {
      seedKey: typeof payload.seedKey === 'string' ? payload.seedKey : null,
      goalId,
      recoveryActionId: action.id,
    },
  }
}, { requires: 'member' })
