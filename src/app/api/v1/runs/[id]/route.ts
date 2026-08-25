import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'

/**
 * GET /api/v1/runs/{id} — the outcome of a run.
 *
 * The other half of an async `run` call: a caller that did not wait needs
 * somewhere to poll.
 */
export const GET = withPublicApi(async (_request, context, params) => {
  const run = await prisma.flowRun.findFirst({
    where: { id: params.id, organizationId: context.organizationId },
    select: {
      id: true, flowId: true, status: true, output: true, error: true,
      startedAt: true, finishedAt: true,
    },
  })
  if (!run) throw Object.assign(new Error('Run not found.'), { statusCode: 404, code: 'NOT_FOUND' })
  return { success: true, run }
}, { scope: 'runs:read' })
