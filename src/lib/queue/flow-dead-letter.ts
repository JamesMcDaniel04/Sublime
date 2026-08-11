/**
 * Dead-letter capture for flow jobs — mirrors dead-letter.ts but marks the
 * FlowRun row failed instead of an AgentExecution. Resume jobs carry
 * `flowRunId`; fresh queued jobs carry `queuedRunId` (the row
 * dispatchFlowExecution pre-created so callers can poll) — either lets a
 * failed job terminalize its run row instead of stranding it `running`
 * until the reaper sweeps it.
 */

import type { Job } from 'bullmq'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { getQueue, QUEUE_NAMES } from './config'
import { Prisma } from '@/generated/prisma/client'

export interface FlowDeadLetterInput {
  queue: string
  jobId?: string
  flowRunId?: string
  organizationId?: string
  data: unknown
  error: string
}

export async function recordFlowDeadLetter(input: FlowDeadLetterInput): Promise<void> {
  if (input.flowRunId) {
    // systemPrisma: id-keyed terminal write from worker job data; flow run id was minted org-scoped upstream.
    // Status-guarded: only a run still `running` may be terminalized here. A
    // resume that rolled back to `waiting` (claim rollback), an already-settled
    // run, or a per-attempt BullMQ failure mid-retry must never be clobbered
    // to failed by the dead-letter path.
    await systemPrisma.flowRun
      .updateMany({
        where: { id: input.flowRunId, status: 'running' },
        data: { status: 'failed', error: input.error.slice(0, 300), finishedAt: new Date() },
      })
      .catch(() => undefined)
  }

  // systemPrisma: worker-side cross-tenant capture. organizationId is copied
  // from the authenticated dispatch row and remains nullable for malformed
  // legacy jobs so even orphan failures are inspectable.
  await systemPrisma.queueDeadLetter.create({
    data: {
      organizationId: input.organizationId,
      queue: input.queue,
      sourceJobId: input.jobId,
      executionType: 'flow',
      executionId: input.flowRunId,
      outboxId: input.data && typeof input.data === 'object' && 'outboxId' in input.data
        ? String((input.data as { outboxId?: unknown }).outboxId ?? '') || null
        : null,
      payload: input.data === undefined ? Prisma.JsonNull : input.data as Prisma.InputJsonValue,
      error: input.error.slice(0, 2000),
    },
  }).catch((error) => apiLogger.error('failed to persist flow dead letter', {
    flowRunId: input.flowRunId,
    error: error instanceof Error ? error.message : String(error),
  }))

  try {
    const dlq = getQueue(QUEUE_NAMES.FLOW_DEAD_LETTER)
    await dlq.add('dead-letter', input, { removeOnComplete: false, removeOnFail: false })
  } catch (error) {
    apiLogger.error('failed to record flow dead letter', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  captureError(new Error(`flow job dead-lettered: ${input.error}`), {
    queue: input.queue,
    jobId: input.jobId,
    flowRunId: input.flowRunId,
    organizationId: input.organizationId,
  })
}

/** Wire onto a Worker's 'failed' event. */
export function deadLetterFromFlowJob(queueName: string) {
  return (job: Job | undefined, error: Error) => {
    if (!job) return
    const data = (job.data ?? {}) as Record<string, unknown>
    const flowRunId =
      typeof data.flowRunId === 'string'
        ? data.flowRunId
        : typeof data.queuedRunId === 'string'
          ? data.queuedRunId
          : undefined
    void recordFlowDeadLetter({
      queue: queueName,
      jobId: job.id,
      flowRunId,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : undefined,
      data: job.data,
      error: error?.message || 'unknown error',
    })
  }
}
