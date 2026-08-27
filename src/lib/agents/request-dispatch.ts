/**
 * Create a human-addressed request and put a run behind it.
 *
 * Shared by the goal composer's API route and the Slack mention router, so
 * "someone asked an agent to do something" has exactly one implementation
 * regardless of which surface the words were typed into. Both callers get the
 * same row shape, the same trigger origin, and the same background semantics.
 *
 * The run is ALWAYS dispatched in the background. A request is a question you
 * walk away from — blocking the HTTP response (or a Slack 3-second ack) on a
 * multi-minute agent run would time out the caller and strand the request.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { encryptRunValue } from '@/lib/agents/run-crypto'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { moveAgentRequest } from '@/lib/agents/request-settle'
import type { SlackRunOrigin } from '@/lib/slack/reply'

export const MAX_REQUEST_TEXT_CHARS = 4000

export type RequestAgent = {
  id: string
  agentType: string
  description: string | null
  metadata: unknown
}

export type CreateAgentRequestInput = {
  organizationId: string
  requestedByUserId: string
  agent: RequestAgent
  text: string
  goalId?: string | null
  /** 'api' = an external caller (a workspace API key, e.g. another agent over MCP). */
  origin?: 'app' | 'slack' | 'api'
  slack?: SlackRunOrigin | null
  /** Seed the new run's transcript from this prior execution (a thread follow-up). */
  continueExecutionId?: string | null
}

export class RequestDispatchError extends Error {
  constructor(message: string, readonly code: 'QUEUE_UNAVAILABLE' | 'WORKER_DISABLED') {
    super(message)
  }
}

export async function createAgentRequest(input: CreateAgentRequestInput): Promise<{
  requestId: string
  executionId: string
}> {
  const { organizationId, requestedByUserId, agent } = input
  const text = input.text.trim().slice(0, MAX_REQUEST_TEXT_CHARS)
  const origin = input.origin ?? 'app'

  const request = await prisma.agentRequest.create({
    data: {
      organizationId,
      requestedByUserId,
      agentTaskId: agent.id,
      goalId: input.goalId ?? null,
      text,
      origin,
      originMeta: input.slack ? JSON.parse(JSON.stringify(input.slack)) : {},
      status: 'pending',
    },
    select: { id: true },
  })

  // The run's input is the request itself. The agent's objective still reaches
  // the model as its system prompt (buildAgentSystemPrompt), which is exactly
  // the "objective frames, request specifies" split — the objective is never
  // passed as input here, or the two would be concatenated into one blurred
  // instruction and the framing would be lost.
  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: encryptRunValue({ prompt: text }),
      trigger: {
        type: 'request',
        requestId: request.id,
        ...(input.slack ? { slack: JSON.parse(JSON.stringify(input.slack)) } : {}),
      },
      metadata: { title: readAgentMetadata(agent.metadata).title || agent.description },
      userId: requestedByUserId,
      organizationId,
    },
    select: { id: true },
  })

  // Link the run immediately so a UI opened right after asking can follow it,
  // rather than waiting for the worker to claim the job.
  await prisma.agentRequest.updateMany({
    where: { id: request.id, organizationId },
    data: { executionId: execution.id },
  })

  const job = {
    executionId: execution.id,
    agentId: agent.id,
    organizationId,
    userId: requestedByUserId,
    input: text,
    requestId: request.id,
    ...(input.continueExecutionId ? { continueExecutionId: input.continueExecutionId } : {}),
  }

  if (inlineExecution) {
    // Dev-only path (resolveExecutionMode defaults production to `queue`), so
    // a detached promise is safe here in a way it would not be on Vercel,
    // where the platform freezes the process with the response.
    const { runAgentExecution } = await import('@/features/agents/execute-agent')
    void runAgentExecution(job).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      apiLogger.error('inline agent request run failed', { requestId: request.id, error: message })
      // A throw BEFORE the run creates its execution row (billing refusal,
      // model construction, an archived agent) escapes the runtime's own
      // failure path — that catch lives inside the function that never
      // started. Without this the request strands at `pending` forever,
      // showing "Queued" to someone whose answer is never coming.
      await failDispatch(request.id, organizationId, execution.id, message)
    })
    return { requestId: request.id, executionId: execution.id }
  }

  if (!workersEnabled) {
    await failDispatch(request.id, organizationId, execution.id, 'The agent worker is disabled.')
    throw new RequestDispatchError('Agent worker is disabled', 'WORKER_DISABLED')
  }

  try {
    await getQueue(QUEUE_NAMES.AGENT_EXECUTION).add('execute-agent', job, { jobId: execution.id })
  } catch (error) {
    // A request whose job never queued must not sit `pending` forever looking
    // like it is about to start. Settle it as failed with a reason the
    // requester can act on.
    await failDispatch(
      request.id,
      organizationId,
      execution.id,
      error instanceof Error ? error.message : 'Unable to queue the run.',
    )
    throw new RequestDispatchError('Unable to queue agent execution', 'QUEUE_UNAVAILABLE')
  }

  return { requestId: request.id, executionId: execution.id }
}

async function failDispatch(requestId: string, organizationId: string, executionId: string, reason: string) {
  await prisma.agentExecution
    .updateMany({
      where: { id: executionId, organizationId },
      data: { status: 'failed', error: reason.slice(0, 300), completedAt: new Date() },
    })
    .catch(() => undefined)
  await moveAgentRequest({ requestId, organizationId, to: 'failed', executionId, error: reason.slice(0, 300) }).catch(
    () => undefined,
  )
}
