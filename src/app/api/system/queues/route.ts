import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { replayDeadLetter } from '@/lib/queue/dlq-replay'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const replaySchema = z.object({ action: z.literal('replay'), deadLetterId: z.string().min(1) })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const [runs, outbox, effects, deadLetters, learning, oldestPending, expiredLeases] = await Promise.all([
    prisma.flowRun.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    prisma.flowDispatchOutbox.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    prisma.flowSideEffect.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    prisma.queueDeadLetter.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, queue: true, executionType: true, executionId: true, error: true,
        status: true, replayAttempts: true, lastReplayError: true, createdAt: true, replayedAt: true,
      },
    }),
    Promise.all([
      prisma.flowLearningObservation.count({ where: { organizationId } }),
      prisma.flowLearningFeedback.count({ where: { organizationId } }),
    ]),
    prisma.flowDispatchOutbox.findFirst({
      where: { organizationId, status: { in: ['pending', 'failed'] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.flowRun.count({
      where: { organizationId, status: { in: ['claimed', 'running'] }, leaseExpiresAt: { lt: new Date() } },
    }),
  ])
  let transport: Record<string, unknown> = { available: false }
  if (workersEnabled) {
    try {
      transport = {
        available: true,
        ...(await getQueue(QUEUE_NAMES.FLOW_EXECUTION).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')),
      }
    } catch (error) {
      transport = { available: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    success: true,
    queues: {
      transport,
      runs: Object.fromEntries(runs.map((row) => [row.status, row._count._all])),
      outbox: Object.fromEntries(outbox.map((row) => [row.status, row._count._all])),
      effects: Object.fromEntries(effects.map((row) => [row.status, row._count._all])),
      learning: { observations: learning[0], feedback: learning[1] },
      oldestPendingAt: oldestPending?.createdAt ?? null,
      expiredLeases,
    },
    deadLetters,
  }
}, { requires: 'insights:workspace', rateLimit: { feature: 'queue-operations', perUser: 30 } })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = replaySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('A dead-letter replay action is required.', 400, 'VALIDATION_ERROR')
  try {
    return { success: true, ...(await replayDeadLetter({
      id: parsed.data.deadLetterId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    })) }
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Replay failed.', 409, 'DLQ_REPLAY_FAILED')
  }
}, { requires: 'insights:workspace', rateLimit: { feature: 'queue-replay', perUser: 10 } })
