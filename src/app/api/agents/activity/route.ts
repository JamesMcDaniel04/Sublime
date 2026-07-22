import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'

/** Lean, selected-agent run history. Kept out of /api/snapshot so login and
 * every shell poll do not transfer run output for agents the user never opens. */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = request.nextUrl.searchParams.get('agentId')?.trim()
  const cursor = request.nextUrl.searchParams.get('cursor')?.trim() || undefined
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get('limit')) || 30, 1), 50)

  if (!agentId) return { success: true, activities: [], nextCursor: null }

  const rows = await prisma.agentExecution.findMany({
    where: {
      organizationId: auth.organizationId,
      agentTaskId: agentId,
      ...executionVisibilityScope(auth.dbUser.id),
    },
    select: {
      id: true,
      agentTaskId: true,
      agentType: true,
      status: true,
      output: true,
      error: true,
      metadata: true,
      startedAt: true,
      completedAt: true,
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const activities = hasMore ? rows.slice(0, limit) : rows
  return {
    success: true,
    activities,
    nextCursor: hasMore ? activities.at(-1)?.id ?? null : null,
  }
})
