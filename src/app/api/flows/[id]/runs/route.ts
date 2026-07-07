import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

// GET /api/flows/[id]/runs — recent runs + each run's per-step detail (input,
// output, error), polled by the builder for live status and run inspection.
// id is the segment before "runs".
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Visibility gate: private-flow run history is owner-only.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const runs = await prisma.flowRun.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    include: {
      steps: {
        orderBy: { order: 'asc' },
        select: { nodeId: true, status: true, order: true, error: true, input: true, output: true, startedAt: true, finishedAt: true },
      },
    },
  })
  const shape = (run: (typeof runs)[number]) => ({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    output: run.output,
    error: run.error,
    steps: run.steps,
  })
  return {
    success: true,
    runs: runs.map(shape),
    latest: runs[0] ? shape(runs[0]) : null,
  }
})
