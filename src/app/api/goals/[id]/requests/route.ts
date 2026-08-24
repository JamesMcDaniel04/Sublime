import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { AGENT_REQUEST_SELECT, serializeAgentRequest } from '@/lib/agents/request-serialize'

export const runtime = 'nodejs'

const PAGE = 30

/** pathname: /api/goals/<goalId>/requests */
const goalIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

export const GET = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)

  // Visibility-scoped, not merely org-scoped — the same rule the work queue
  // uses. A restricted goal is ABSENT rather than denied, so this 404s.
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId: auth.organizationId,
      ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }),
    },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const rows = await prisma.agentRequest.findMany({
    where: { organizationId: auth.organizationId, goalId },
    orderBy: { createdAt: 'desc' },
    take: PAGE,
    select: AGENT_REQUEST_SELECT,
  })

  return { success: true, items: rows.map(serializeAgentRequest) }
}, { requires: 'member' })
