/**
 * Restricting a goal, and managing who may see it.
 *
 * Every handler declares `goal:restrict`, so the capability check happens in the
 * wrapper rather than inline — a handler that forgot to check would not compile,
 * because the declaration is a mandatory argument.
 */
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { withElevatedAccess } from '@/lib/server/elevated'

/** pathname: /api/goals/<id>/members */
const goalIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

/**
 * Resolve the goal, admin-side: not visibility-scoped, because an admin holds
 * goal:restrict over every org goal in their workspace including ones they are
 * not a member of.
 */
async function orgGoalOr404(organizationId: string, id: string) {
  const goal = await prisma.goal.findFirst({
    where: { id, organizationId },
    select: { id: true, access: true, ownerUserId: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  // Personal goals are already restricted by ownerUserId. Two mechanisms
  // expressing one idea is how contradictions get built, so this refuses rather
  // than quietly layering a second one on top.
  if (goal.ownerUserId) throw new ApiError('Personal goals cannot be restricted', 400, 'PERSONAL_GOAL')
  return goal
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const goal = await orgGoalOr404(auth.organizationId, goalIdFrom(request.nextUrl.pathname))
  const members = await prisma.goalMember.findMany({
    where: { goalId: goal.id },
    orderBy: { createdAt: 'asc' },
  })
  return { success: true, access: goal.access, members }
}, { requires: 'goal:restrict' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const goal = await orgGoalOr404(auth.organizationId, goalIdFrom(request.nextUrl.pathname))
  const { access } = z.object({ access: z.enum(['workspace', 'restricted']) }).parse(await request.json())

  // Audited: changing who can see a goal is a cross-owner act on shared work,
  // and withElevatedAccess is the only path that grants it — so the change
  // cannot happen without the log entry.
  await withElevatedAccess(
    auth,
    {
      action: 'admin.resource.update',
      resourceType: 'goal',
      resourceId: goal.id,
      detail: { access, previousAccess: goal.access },
    },
    async () =>
      prisma.goal.update({
        where: { id: goal.id, organizationId: auth.organizationId },
        data: { access },
      }),
  )
  return { success: true, access }
}, { requires: 'goal:restrict' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const goal = await orgGoalOr404(auth.organizationId, goalIdFrom(request.nextUrl.pathname))
  const { userId } = z.object({ userId: z.string().min(1) }).parse(await request.json())

  // Org-scoped: a goal's membership may only name people in this workspace.
  const member = await prisma.user.findFirst({
    where: { id: userId, organizationId: auth.organizationId, isActive: true },
    select: { id: true },
  })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')

  // Idempotent by composite key: adding someone twice is a no-op rather than a
  // duplicate-key error, so a double-click is not an error state.
  await prisma.goalMember.upsert({
    where: { goalId_userId: { goalId: goal.id, userId: member.id } },
    create: { goalId: goal.id, userId: member.id },
    update: {},
  })
  await withElevatedAccess(
    auth,
    {
      action: 'admin.resource.update',
      resourceType: 'goal',
      resourceId: goal.id,
      targetUserId: member.id,
      detail: { membership: 'added' },
    },
    async () => undefined,
  )
  return { success: true }
}, { requires: 'goal:restrict' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const goal = await orgGoalOr404(auth.organizationId, goalIdFrom(request.nextUrl.pathname))
  const userId = request.nextUrl.searchParams.get('userId')
  if (!userId) throw new ApiError('userId is required')

  // deleteMany, not delete: removing someone who was never a member is the
  // caller's intended end state, not an error.
  await prisma.goalMember.deleteMany({ where: { goalId: goal.id, userId } })
  await withElevatedAccess(
    auth,
    {
      action: 'admin.resource.update',
      resourceType: 'goal',
      resourceId: goal.id,
      targetUserId: userId,
      detail: { membership: 'removed' },
    },
    async () => undefined,
  )
  return { success: true }
}, { requires: 'goal:restrict' })
