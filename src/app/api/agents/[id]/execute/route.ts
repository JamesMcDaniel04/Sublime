import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { agentReadScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { recordUserEvent } from '@/lib/behavior/record-event'

export const runtime = 'nodejs'
export const maxDuration = 1200

async function failExecution(executionId: string, organizationId: string, error: unknown) {
  await prisma.agentExecution.update({
    where: { id: executionId, organizationId },
    data: {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date(),
    },
  })
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  // Same ceiling as the webhook trigger route (60/min), keyed per user: being
  // authenticated is not a license to mint unbounded 20-minute runs.
  const limited = await rateLimit(`execute:${auth.dbUser.id}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')
  const { input } = z.object({ input: z.string().optional() }).parse(await request.json())
  const agent = await prisma.agentTask.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      status: 'ACTIVE',
      // Private agents are runnable only by their owner.
      ...agentReadScope(auth.dbUser.id),
    },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  // Skills are composed into the system prompt inside runAgentExecution, shared
  // by every trigger — pass the raw objective so they aren't applied twice.
  const runInput = input?.trim() || agent.objective

  const execution = await prisma.agentExecution.create({
    data: {
      agentType: agent.agentType,
      agentTaskId: agent.id,
      status: 'pending',
      input: { prompt: runInput },
      trigger: { type: 'manual' },
      metadata: { title: (agent.metadata as any)?.title || agent.description },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_run_manual', resourceType: 'agent', resourceId: agent.id,
    context: { executionId: execution.id, name: (agent.metadata as { title?: string } | null)?.title || agent.description },
  })

  if (inlineExecution) {
    try {
      const result = await runAgentExecution({
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      })
      return { success: true, executionId: execution.id, result }
    } catch (error) {
      await failExecution(execution.id, auth.organizationId, error)
      throw new ApiError('Agent run failed', 500, 'RUN_FAILED')
    }
  } else {
    if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
    try {
      const queue = getQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('execute-agent', {
        executionId: execution.id,
        agentId: agent.id,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        input: runInput,
      }, { jobId: execution.id })
    } catch (error) {
      await failExecution(execution.id, auth.organizationId, error)
      throw new ApiError('Unable to queue agent execution', 503, 'QUEUE_UNAVAILABLE')
    }
    return { success: true, executionId: execution.id, status: 'pending' }
  }
}, { requires: 'member' })
