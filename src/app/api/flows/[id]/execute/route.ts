import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { runFlowExecution } from '@/features/flows/execute-flow'

// POST /api/flows/[id]/execute — run a flow manually. id is the path segment
// before "execute".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Visibility gate: a private flow may only be run by its owner.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const body = await request.json().catch(() => ({}))
  const parsed = z.object({ input: z.string().optional(), flowRunId: z.string().optional(), reply: z.string().optional() }).parse(body)
  const run = await runFlowExecution({
    flowId: id,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    input: parsed.input ?? '',
    flowRunId: parsed.flowRunId,
    reply: parsed.reply,
  })
  return { success: true, run }
})
