/**
 * POST /api/settings/members/[id]/reassign — move a member's work to someone
 * else. The offboarding path.
 *
 * Scoped to ONE member on purpose: every resource id in the body must belong
 * to the member named in the URL, or the request is refused whole. Without
 * that check this endpoint is a general ownership editor, which is a much
 * bigger tool than offboarding needs.
 *
 * Every reassignment runs through withElevatedAccess, so the audit row and the
 * ownership change are the same code path — a reassign cannot happen unlogged.
 */
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { withElevatedAccess } from '@/lib/server/elevated'

export const runtime = 'nodejs'

/** pathname: /api/settings/members/<id>/reassign */
const memberIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

const bodySchema = z.object({
  resourceIds: z.array(z.string().min(1)).min(1).max(200),
  toUserId: z.string().min(1),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const fromUserId = memberIdFrom(request.nextUrl.pathname)
  const { resourceIds, toUserId } = bodySchema.parse(await request.json())

  const [from, to] = await Promise.all([
    prisma.user.findFirst({
      where: { id: fromUserId, organizationId: auth.organizationId },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { id: toUserId, organizationId: auth.organizationId },
      select: { id: true, isActive: true },
    }),
  ])
  if (!from) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  if (!to) throw new ApiError('Target member not found', 404, 'NOT_FOUND')
  // An inactive target strands the work a second time — the exact failure
  // offboarding exists to prevent.
  if (!to.isActive) throw new ApiError('Reassign to an active member', 400, 'INACTIVE_TARGET')

  const ids = [...new Set(resourceIds)]
  const [flows, agents, goals] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId: auth.organizationId, userId: from.id, id: { in: ids } },
      select: { id: true },
    }),
    prisma.agentTask.findMany({
      where: { organizationId: auth.organizationId, userId: from.id, id: { in: ids } },
      select: { id: true },
    }),
    prisma.goal.findMany({
      where: { organizationId: auth.organizationId, ownerUserId: from.id, id: { in: ids } },
      select: { id: true },
    }),
  ])
  const owned = new Map<string, 'flow' | 'agent' | 'goal'>([
    ...flows.map((row) => [row.id, 'flow'] as const),
    ...agents.map((row) => [row.id, 'agent'] as const),
    ...goals.map((row) => [row.id, 'goal'] as const),
  ])

  // Refused WHOLE, not partially applied: a mixed batch succeeding for some
  // ids and silently skipping others would report success while leaving work
  // stranded — the admin must know exactly what did not move.
  const foreign = ids.filter((id) => !owned.has(id))
  if (foreign.length) {
    throw new ApiError(
      `${foreign.length} resource(s) do not belong to this member`,
      400,
      'NOT_OWNED_BY_MEMBER',
    )
  }

  for (const id of ids) {
    const type = owned.get(id)!
    await withElevatedAccess(
      auth,
      {
        action: 'admin.resource.reassign',
        resourceType: type,
        resourceId: id,
        targetUserId: from.id,
        detail: { toUserId: to.id },
      },
      async () => {
        if (type === 'flow') {
          await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { userId: to.id } })
        } else if (type === 'agent') {
          await prisma.agentTask.update({ where: { id, organizationId: auth.organizationId }, data: { userId: to.id } })
        } else {
          await prisma.goal.update({ where: { id, organizationId: auth.organizationId }, data: { ownerUserId: to.id } })
        }
      },
    )
  }

  return { success: true, reassigned: ids.length }
}, { requires: 'resource:takeover' })
