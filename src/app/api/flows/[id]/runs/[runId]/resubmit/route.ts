import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowRunVisibilityScope } from '@/lib/server/visibility'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { storedRunInput } from '@/lib/flows/reuse-input'

/** Re-run a prior execution with its original input against the current draft. */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parts = request.nextUrl.pathname.split('/')
  const flowId = parts.at(-4)
  const runId = parts.at(-2)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')
  const flow = await prisma.flow.findFirst({ where: { id: flowId, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) }, select: { id: true, userId: true } })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  // A run's stored input can carry the starting user's data — only that user
  // (or the flow owner for ownerless legacy runs) may read and re-dispatch it.
  const prior = await prisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId: auth.organizationId, ...flowRunVisibilityScope(auth.dbUser.id, flow.userId) },
    select: { input: true },
  })
  if (!prior) throw new ApiError('Run not found', 404, 'NOT_FOUND')
  const result = await dispatchFlowExecution({ flowId, organizationId: auth.organizationId, userId: auth.dbUser.id, input: storedRunInput(prior.input), trigger: { type: 'manual', resubmittedFrom: runId } })
  return { success: true, run: 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result }
})
