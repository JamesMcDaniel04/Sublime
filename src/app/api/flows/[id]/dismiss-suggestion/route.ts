import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * POST /api/flows/[id]/dismiss-suggestion — dismiss a *suggested* draft flow
 * from the /flows rail. Unlike a plain DELETE (still used for normal, non-
 * suggested flows), this also marks the suggestion's source AgentMemory row
 * as dismissed before deleting the flow, so:
 *   - the "Suggested for you" rail's dedupe (against open suggestion
 *     memories) doesn't just regenerate the same idea on the next synthesis
 *     pass, and
 *   - dismissal history is preserved (the memory row survives with
 *     status:'dismissed', matching every other suggestion-dismissal path in
 *     this feature — see /api/agents/[id]/memories and
 *     /api/flows/[id]/suggestions).
 * The flow's `metadata.sourceMemoryId` (set at draft-creation time in
 * suggest-workflows.ts) is the link; a flow without `metadata.suggested` is
 * not a suggestion and this route 400s rather than silently no-op deleting.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, metadata: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const metadata = flow.metadata && typeof flow.metadata === 'object' && !Array.isArray(flow.metadata) ? (flow.metadata as Record<string, unknown>) : {}
  if (!metadata.suggested) throw new ApiError('Flow is not a suggestion', 400, 'NOT_A_SUGGESTION')

  const sourceMemoryId = typeof metadata.sourceMemoryId === 'string' ? metadata.sourceMemoryId : null
  if (sourceMemoryId) {
    await prisma.agentMemory.updateMany({
      where: { id: sourceMemoryId, organizationId: auth.organizationId },
      data: { status: 'dismissed' },
    })
  }

  await prisma.flow.deleteMany({ where: { id, organizationId: auth.organizationId } })
  return { success: true }
})
