/**
 * Dead-letter capture for agent jobs.
 *
 * Agent runs are NOT auto-retried (side effects), so a failed job would
 * otherwise leave only its removed BullMQ record. This records failures to a
 * dead-letter queue and marks the execution failed in the DB — durable,
 * inspectable, and re-runnable by an operator without silent replay.
 */

import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { createQueue, QUEUE_NAMES } from './config'

export interface DeadLetterInput {
  queue: string
  jobId?: string
  executionId?: string
  organizationId?: string
  data: unknown
  error: string
}

export async function recordDeadLetter(input: DeadLetterInput): Promise<void> {
  // Best-effort: mark the execution failed so the UI reflects it.
  if (input.executionId) {
    await prisma.agentExecution
      .update({
        where: { id: input.executionId },
        data: { status: 'failed', error: input.error.slice(0, 300), completedAt: new Date() },
      })
      .catch(() => undefined)
  }

  try {
    const dlq = createQueue(QUEUE_NAMES.DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    // If even the DLQ enqueue fails, at least log + report — never throw here.
    apiLogger.error('failed to record dead letter', {
      executionId: input.executionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  captureError(new Error(`agent job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    executionId: input.executionId,
    organizationId: input.organizationId,
  })
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    void recordDeadLetter({
      queue: queueName,
      jobId: job.id,
      executionId: typeof data.executionId === 'string' ? data.executionId : undefined,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}
