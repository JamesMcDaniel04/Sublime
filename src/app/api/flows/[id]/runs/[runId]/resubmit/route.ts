import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { storedRunInput } from '@/lib/flows/reuse-input'

/** Re-run a prior execution with its original input against the current draft. */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parts = request.nextUrl.pathname.split('/')
  const flowId = parts.at(-4)
  const runId = parts.at(-2)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')
  const flow = await prisma.flow.findFirst({ where: { id: flowId, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) }, select: { id: true } })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const prior = await prisma.flowRun.findFirst({ where: { id: runId, flowId, organizationId: auth.organizationId }, select: { input: true } })
  if (!prior) throw new ApiError('Run not found', 404, 'NOT_FOUND')
  const result = await dispatchFlowExecution({ flowId, organizationId: auth.organizationId, userId: auth.dbUser.id, input: storedRunInput(prior.input), trigger: { type: 'manual', resubmittedFrom: runId } })
  return { success: true, run: 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result }
})
