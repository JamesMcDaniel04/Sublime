import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { deriveRunWaiting } from '@/lib/flows/run-waiting'
import { recordUserEvent } from '@/lib/behavior/record-event'

export const runtime = 'nodejs'
export const maxDuration = 1200

// POST /api/flows/[id]/execute — run a flow manually. id is the path segment
// before "execute".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Visibility gate: a private flow may only be run by its owner.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true, userId: true, graph: true, publishedGraph: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const body = await request.json().catch(() => ({}))
  // Replies must carry content: an all-whitespace reply would resume a paused
  // step with an empty answer (the UI disables empty sends; this guards the API).
  const parsed = z
    .object({
      input: z.unknown().optional(),
      flowRunId: z.string().optional(),
      reply: z.string().refine((value) => value.trim().length > 0, 'Reply cannot be empty.').optional(),
      startNodeId: z.string().optional(),
      mockOutputs: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(body)
  // flowRunId only resumes a paused run when paired with the user's reply —
  // without a reply there is nothing to resume with, and silently starting a
  // fresh run instead would strand the caller's expectation of continuity.
  if (parsed.flowRunId && parsed.reply === undefined) {
    throw new ApiError('flowRunId requires a reply — to start a new run, omit flowRunId.', 400, 'FLOW_RESUME_REQUIRES_REPLY')
  }
  // Resume hardening: the run being resumed must belong to THIS flow and org —
  // otherwise a crafted flowRunId could re-interpret another flow's run
  // against this flow's graph.
  if (parsed.flowRunId) {
    const owned = await prisma.flowRun.findFirst({
      where: { id: parsed.flowRunId, flowId: flow.id, organizationId: auth.organizationId },
      select: { id: true, status: true, userId: true },
    })
    if (!owned) throw new ApiError('Run not found', 404, 'NOT_FOUND')
    if (parsed.reply !== undefined && owned.status === 'waiting') {
      const steps = await prisma.flowRunStep.findMany({
        where: { flowRunId: owned.id },
        orderBy: { order: 'asc' },
        select: { nodeId: true, status: true, output: true },
      })
      const waiting = deriveRunWaiting(owned.status, steps)
      // A durable Wait pause resumes on the scheduler, never via a user reply.
      if (waiting?.kind === 'time') throw new ApiError('This run is waiting for its scheduled resume time.', 400, 'FLOW_RUN_AWAITING_TIME')
      // Run privacy: a shared flow does not share its runs. Only the run's
      // owner, the flow's owner (ownerless legacy runs included), or the
      // waiting humanReview step's explicit assignee may resume — resuming
      // returns the run's output, which can carry the owner's data.
      if (owned.userId !== auth.dbUser.id && flow.userId !== auth.dbUser.id) {
        const graph = (flow.publishedGraph ?? flow.graph) as { nodes?: Array<{ id: string; type: string; data?: { assigneeUserId?: string } }> } | null
        const waitingNode = graph?.nodes?.find((node) => node.id === waiting?.nodeId)
        const assignee = waitingNode?.type === 'humanReview' ? waitingNode.data?.assigneeUserId?.trim() : undefined
        if (!assignee || assignee !== auth.dbUser.id) {
          throw new ApiError('Only the person this run is waiting on can reply to it.', 403, 'FLOW_RUN_NOT_YOURS')
        }
      }
    }
  }
  if (!parsed.flowRunId) {
    await recordUserEvent({
      organizationId: auth.organizationId, userId: auth.dbUser.id,
      kind: 'flow_run_manual', resourceType: 'flow', resourceId: flow.id,
    })
  }
  // `background: true` decouples a fresh manual run from THIS request so it
  // keeps running when the user navigates away from the builder (queue mode
  // already does this; inline mode now pre-creates the row and runs detached).
  // Both modes then return immediately with the run id and the panel polls it;
  // a resume (flowRunId + reply) still runs awaited so its claim errors surface.
  const result = await dispatchFlowExecution({
    flowId: id,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    input: parseFlowInput(parsed.input),
    flowRunId: parsed.flowRunId,
    reply: parsed.reply,
    startNodeId: parsed.startNodeId,
    mockOutputs: parsed.mockOutputs,
  }, { background: true })
  const run = 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result
  return { success: true, run }
}, { requires: 'member' })
