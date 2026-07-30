/**
 * GET /api/settings/members/[id]/resources — what one member owns.
 *
 * NAMES ONLY: id, name, type, updatedAt. No graphs, objectives or content — a
 * deliberate narrowing of piece A's full-read decision. Listing what someone
 * owns solves offboarding (the driving case); reading their drafts is a
 * different feature with a different privacy cost, and nothing needs it yet.
 * The e2e test pins the row shape to exactly these four keys.
 *
 * The listing runs inside withElevatedAccess even though the route already
 * declares resource:takeover. The declaration alone grants but does not
 * record, and this is a cross-owner READ — the act elevated.ts exists to keep
 * out of the shadows. Narrow data is not the same as unremarkable data: an
 * admin enumerating a colleague's work is exactly what an audit log is read
 * for afterwards.
 */
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { withElevatedAccess } from '@/lib/server/elevated'

export const runtime = 'nodejs'

/** pathname: /api/settings/members/<id>/resources */
const memberIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

export const GET = withAuthenticatedApi(async (request, auth) => {
  const memberId = memberIdFrom(request.nextUrl.pathname)
  const member = await prisma.user.findFirst({
    where: { id: memberId, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')

  // The audit row names the MEMBER, not each listed resource: one deliberate
  // act of looking at someone's work is one entry. Fanning out a row per flow
  // would bury the signal it exists to carry.
  const [flows, agents, goals] = await withElevatedAccess(
    auth,
    {
      action: 'admin.resource.read',
      resourceType: 'user',
      resourceId: member.id,
      targetUserId: member.id,
      detail: { surface: 'member-owned-work-listing' },
    },
    () => Promise.all([
      prisma.flow.findMany({
        where: { organizationId: auth.organizationId, userId: member.id },
        select: { id: true, name: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.agentTask.findMany({
        where: { organizationId: auth.organizationId, userId: member.id, status: { not: 'DELETED' } },
        // AgentTask has no name column; description is its display label.
        select: { id: true, description: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.goal.findMany({
        where: { organizationId: auth.organizationId, ownerUserId: member.id, status: { not: 'archived' } },
        select: { id: true, name: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]),
  )

  return {
    success: true,
    resources: [
      ...flows.map((flow) => ({ id: flow.id, name: flow.name, type: 'flow' as const, updatedAt: flow.updatedAt })),
      ...agents.map((agent) => ({ id: agent.id, name: agent.description, type: 'agent' as const, updatedAt: agent.updatedAt })),
      ...goals.map((goal) => ({ id: goal.id, name: goal.name, type: 'goal' as const, updatedAt: goal.updatedAt })),
    ],
  }
}, { requires: 'resource:takeover' })
