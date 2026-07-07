import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { executionVisibilityScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'
export const maxDuration = 300

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Execution id is required')
  const { message } = z.object({ message: z.string().min(1).max(8000) }).parse(await request.json())

  const execution = await prisma.agentExecution.findFirst({
    where: { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
  })
  if (!execution) throw new ApiError('Execution not found', 404, 'NOT_FOUND')
  if (execution.status !== 'waiting_for_input' || !execution.agentTaskId) {
    throw new ApiError('Execution is not waiting for input', 409, 'NOT_WAITING')
  }

  await prisma.executionMessage.create({
    data: { executionId: execution.id, role: 'user', content: message },
  })

  if (inlineExecution) {
    try {
      const result = await runAgentExecution({
        executionId: execution.id,
        agentId: execution.agentTaskId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        resume: true,
        reply: message,
      })
      return { success: true, executionId: execution.id, result }
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      })
      throw new ApiError('Agent resume failed', 500, 'RUN_FAILED')
    }
  } else {
    if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
    try {
      const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('resume-agent', {
        executionId: execution.id,
        agentId: execution.agentTaskId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        resume: true,
        reply: message,
      }, { jobId: `${execution.id}-resume-${Date.now()}` })
    } catch {
      throw new ApiError('Unable to queue agent resume', 503, 'QUEUE_UNAVAILABLE')
    }
    return { success: true, executionId: execution.id, status: 'resuming' }
  }
})
