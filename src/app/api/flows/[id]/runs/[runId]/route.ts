import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowRunVisibilityScope } from '@/lib/server/visibility'

// DELETE /api/flows/[id]/runs/[runId] — remove a run (and, via cascade, its
// steps) from history. Only settled runs are deletable: a running/waiting run
// still has an executor (or a pending reply) attached to it, and deleting the
// row out from under either would strand them. Scope mirrors run visibility —
// you can delete the runs you can see: your own, plus ownerless legacy runs
// when you own the flow.
const DELETABLE_STATUSES = ['succeeded', 'failed']

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const parts = request.nextUrl.pathname.split('/')
  const flowId = parts.at(-3)
  const runId = parts.at(-1)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')

  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const run = await prisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId: auth.organizationId, ...flowRunVisibilityScope(auth.dbUser.id, flow.userId) },
    select: { id: true, status: true },
  })
  if (!run) throw new ApiError('Run not found', 404, 'NOT_FOUND')
  if (!DELETABLE_STATUSES.includes(run.status)) {
    throw new ApiError('Only finished runs can be deleted — stop or resume this run first.', 409, 'RUN_NOT_SETTLED')
  }

  await prisma.flowRun.delete({ where: { id: run.id, organizationId: auth.organizationId } })
  return { success: true }
})
