import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { recordFlowObservations } from '@/lib/intelligence/flow-observations'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowRunVisibilityScope } from '@/lib/server/visibility'

const schema = z.object({
  outcome: z.enum(['worked', 'failed', 'corrected', 'accepted', 'rejected']),
  score: z.number().int().min(-2).max(2).optional(),
  note: z.string().trim().max(500).optional(),
})

async function visibleRun(flowId: string, runId: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId, ...flowReadScope(userId) },
    select: { id: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const run = await prisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId, ...flowRunVisibilityScope(userId, flow.userId) },
    select: { id: true, status: true, error: true, userId: true },
  })
  if (!run) throw new ApiError('Run not found', 404, 'NOT_FOUND')
  return run
}

function ids(request: Request) {
  const parts = new URL(request.url).pathname.split('/')
  return { flowId: parts.at(-4), runId: parts.at(-2) }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const { flowId, runId } = ids(request)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')
  await visibleRun(flowId, runId, auth.organizationId, auth.dbUser.id)
  const observation = await prisma.flowLearningObservation.findFirst({
    where: { observationKey: `flow-run:${runId}`, organizationId: auth.organizationId },
    include: { feedback: { orderBy: { createdAt: 'desc' }, take: 20 } },
  })
  return { success: true, observation }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { flowId, runId } = ids(request)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Choose a valid run outcome.', 400, 'VALIDATION_ERROR')
  const run = await visibleRun(flowId, runId, auth.organizationId, auth.dbUser.id)
  if (!['succeeded', 'failed', 'stopped'].includes(run.status)) {
    throw new ApiError('Feedback is available after the run settles.', 409, 'RUN_NOT_SETTLED')
  }
  let observation = await prisma.flowLearningObservation.findFirst({
    where: { observationKey: `flow-run:${runId}`, organizationId: auth.organizationId },
  })
  if (!observation) {
    await recordFlowObservations({
      organizationId: auth.organizationId,
      userId: run.userId,
      flowId,
      flowRunId: runId,
      status: run.status,
      error: run.error,
    })
    observation = await prisma.flowLearningObservation.findFirst({
      where: { observationKey: `flow-run:${runId}`, organizationId: auth.organizationId },
    })
  }
  if (!observation) throw new ApiError('Run observation could not be created.', 500, 'OBSERVATION_FAILED')
  const feedback = await prisma.flowLearningFeedback.create({
    data: {
      observationId: observation.id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      source: 'human',
      outcome: parsed.data.outcome,
      score: parsed.data.score,
      note: parsed.data.note || null,
    },
  })
  await recordUserEvent({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    kind: 'flow_run_feedback',
    resourceType: 'flow',
    resourceId: flowId,
    context: { flowRunId: runId, outcome: parsed.data.outcome, score: parsed.data.score ?? null },
  })
  return { success: true, feedback }
}, { requires: 'member' })
