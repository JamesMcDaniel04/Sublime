import { prisma } from '@/lib/prisma'
import { getQueue } from './config'
import { publishFlowDispatchOutbox } from './flow-outbox'

export class DeadLetterReplayError extends Error {}

export async function replayDeadLetter(params: {
  id: string
  organizationId: string
  userId: string
}): Promise<{ replayed: true }> {
  const claimed = await prisma.queueDeadLetter.updateMany({
    where: { id: params.id, organizationId: params.organizationId, status: { in: ['open', 'replay_failed'] } },
    data: {
      status: 'replaying',
      replayAttempts: { increment: 1 },
      lastReplayError: null,
      replayedByUserId: params.userId,
      replayedAt: new Date(),
    },
  })
  if (claimed.count !== 1) throw new DeadLetterReplayError('This dead letter is already resolved or being replayed.')
  const row = await prisma.queueDeadLetter.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
  if (!row) throw new DeadLetterReplayError('Dead letter not found.')

  try {
    if (row.executionType === 'flow') {
      if (!row.executionId || !row.outboxId) throw new DeadLetterReplayError('This legacy flow dead letter has no replayable outbox.')
      const ambiguous = await prisma.flowSideEffect.count({
        where: { organizationId: params.organizationId, flowRunId: row.executionId, status: 'ambiguous' },
      })
      if (ambiguous > 0) {
        throw new DeadLetterReplayError('Replay blocked: this run has an ambiguous unprotected write. Verify the provider outcome first.')
      }
      await prisma.$transaction([
        prisma.flowRun.updateMany({
          where: { id: row.executionId, organizationId: params.organizationId, status: { in: ['failed', 'queued', 'claimed', 'running'] } },
          data: { status: 'queued', error: null, finishedAt: null, queuedAt: new Date(), workerId: null, claimedAt: null, heartbeatAt: null, leaseExpiresAt: null },
        }),
        prisma.flowDispatchOutbox.updateMany({
          where: { id: row.outboxId, organizationId: params.organizationId },
          data: { status: 'failed', availableAt: new Date(), lockedAt: null, consumedAt: null, lastError: null },
        }),
      ])
      const published = await publishFlowDispatchOutbox(row.outboxId)
      if (!published) throw new DeadLetterReplayError('The replay intent was restored but could not be published yet. It will be retried automatically.')
    } else if (row.executionType === 'agent') {
      if (!row.executionId || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
        throw new DeadLetterReplayError('This agent dead letter does not contain a replayable execution payload.')
      }
      const reset = await prisma.agentExecution.updateMany({
        where: { id: row.executionId, organizationId: params.organizationId, status: 'failed' },
        data: { status: 'running', error: null, completedAt: null },
      })
      if (reset.count !== 1) throw new DeadLetterReplayError('The agent execution is no longer in a replayable failed state.')
      await getQueue(row.queue).add('dlq-replay', row.payload as Record<string, unknown>, {
        jobId: `dlq-${row.id}-${row.replayAttempts}`,
        attempts: 1,
      })
    } else {
      throw new DeadLetterReplayError(`Replay is not supported for ${row.executionType} dead letters.`)
    }
    await prisma.queueDeadLetter.updateMany({
      where: { id: row.id, organizationId: params.organizationId, status: 'replaying' },
      data: { status: 'replayed', resolvedAt: new Date() },
    })
    return { replayed: true }
  } catch (error) {
    await prisma.queueDeadLetter.updateMany({
      where: { id: row.id, organizationId: params.organizationId, status: 'replaying' },
      data: { status: 'replay_failed', lastReplayError: (error instanceof Error ? error.message : String(error)).slice(0, 1000) },
    }).catch(() => undefined)
    throw error
  }
}
