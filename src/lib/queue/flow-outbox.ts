import { createHash } from 'crypto'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getQueue, QUEUE_NAMES } from './config'
import { flowJobOptions } from '@/lib/flows/queue-options'

export const FLOW_OUTBOX_LOCK_MS = 60_000
export const FLOW_OUTBOX_RECONCILE_MS = 120_000
export const FLOW_OUTBOX_BATCH = 100

export function fairDispatchOrder<T extends { organizationId: string; availableAt: Date; id: string }>(rows: T[], limit: number): T[] {
  const byOrg = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = byOrg.get(row.organizationId) ?? []
    bucket.push(row)
    byOrg.set(row.organizationId, bucket)
  }
  const result: T[] = []
  while (result.length < limit && byOrg.size > 0) {
    for (const [organizationId, bucket] of byOrg) {
      const next = bucket.shift()
      if (next) result.push(next)
      if (bucket.length === 0) byOrg.delete(organizationId)
      if (result.length >= limit) break
    }
  }
  return result
}

export type FlowQueueJobData = {
  outboxId: string
  flowRunId: string
  organizationId: string
}

export function flowRunClaimDecision(
  status: string,
  leaseExpiresAt: Date | null | undefined,
  now: Date,
): 'claim' | 'wait' | 'terminal' {
  if (['succeeded', 'failed', 'stopped'].includes(status)) return 'terminal'
  if (status === 'queued') return 'claim'
  if ((status === 'claimed' || status === 'running') && leaseExpiresAt && leaseExpiresAt < now) return 'claim'
  return 'wait'
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function flowDispatchPayloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function retryAt(attempts: number, now: Date): Date {
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)))
  return new Date(now.getTime() + delay)
}

/**
 * Publish one durable dispatch intent. Claiming is status/lock guarded so the
 * web request, cron fallback, and worker recovery loop may race safely. A
 * crash after queue.add but before the DB update is safe: the next publisher
 * reuses the same BullMQ job id (`flow-${outbox.id}`).
 */
export async function publishFlowDispatchOutbox(outboxId: string, now = new Date()): Promise<boolean> {
  const staleLock = new Date(now.getTime() - FLOW_OUTBOX_LOCK_MS)
  const stalePublished = new Date(now.getTime() - FLOW_OUTBOX_RECONCILE_MS)
  // systemPrisma: worker/system publisher claims an org-unknown outbox id.
  const claimed = await systemPrisma.flowDispatchOutbox.updateMany({
    where: {
      id: outboxId,
      OR: [
        { status: { in: ['pending', 'failed'] }, availableAt: { lte: now } },
        { status: 'publishing', lockedAt: { lt: staleLock } },
        // Redis may acknowledge queue.add and then lose the job before the
        // worker sees it. Periodically reassert the stable job id from DB.
        { status: 'published', updatedAt: { lt: stalePublished } },
      ],
    },
    data: { status: 'publishing', lockedAt: now, attempts: { increment: 1 }, lastError: null },
  })
  if (claimed.count === 0) return false

  // systemPrisma: row was claimed above by globally unique id.
  const row = await systemPrisma.flowDispatchOutbox.findUnique({ where: { id: outboxId } })
  if (!row) return false
  try {
    const queue = getQueue(QUEUE_NAMES.FLOW_EXECUTION)
    const options = flowJobOptions(row.id)
    const jobId = options.jobId!
    // A prior setup-only attempt may have failed and released this outbox.
    // Remove that terminal BullMQ shell before re-adding the same stable id.
    // Active jobs are left untouched and queue.add simply deduplicates them.
    const prior = await queue.getJob(jobId)
    if (prior) {
      const state = await prior.getState()
      if (state === 'failed' || state === 'completed') await prior.remove()
    }
    await queue.add(
      'execute-flow',
      { outboxId: row.id, flowRunId: row.flowRunId, organizationId: row.organizationId } satisfies FlowQueueJobData,
      options,
    )
    // systemPrisma: terminalize the globally claimed outbox row.
    await systemPrisma.flowDispatchOutbox.updateMany({
      where: { id: row.id, status: 'publishing' },
      data: { status: 'published', publishedAt: new Date(), lockedAt: null },
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // systemPrisma: release the globally claimed row for bounded retry.
    await systemPrisma.flowDispatchOutbox.updateMany({
      where: { id: row.id, status: 'publishing' },
      data: {
        status: 'failed',
        // `attempts` was incremented by the claim above and is already the
        // current attempt number.
        availableAt: retryAt(row.attempts, now),
        lockedAt: null,
        lastError: message.slice(0, 300),
      },
    })
    apiLogger.warn('flow outbox publish failed', { outboxId: row.id, flowRunId: row.flowRunId, error: message })
    return false
  }
}

/** Recover pending/failed or abandoned-publishing intents in bounded batches. */
export async function flushFlowDispatchOutbox(now = new Date(), limit = FLOW_OUTBOX_BATCH): Promise<number> {
  const staleLock = new Date(now.getTime() - FLOW_OUTBOX_LOCK_MS)
  const stalePublished = new Date(now.getTime() - FLOW_OUTBOX_RECONCILE_MS)
  // systemPrisma: global worker/cron recovery sweep by design.
  const candidates = await systemPrisma.flowDispatchOutbox.findMany({
    where: {
      OR: [
        { status: { in: ['pending', 'failed'] }, availableAt: { lte: now } },
        { status: 'publishing', lockedAt: { lt: staleLock } },
        { status: 'published', updatedAt: { lt: stalePublished } },
      ],
    },
    orderBy: { availableAt: 'asc' },
    // Read ahead so one noisy tenant cannot fill the whole publish batch.
    take: Math.max(limit, Math.min(1000, limit * 10)),
    select: { id: true, organizationId: true, availableAt: true },
  })
  const rows = fairDispatchOrder(candidates, limit)
  const results = await Promise.allSettled(rows.map((row) => publishFlowDispatchOutbox(row.id, now)))
  return results.filter((result) => result.status === 'fulfilled' && result.value).length
}

export async function loadFlowDispatch(outboxId: string, flowRunId: string) {
  // systemPrisma: worker job carries globally unique ids minted by the scoped
  // dispatch transaction; both ids are rechecked together before execution.
  return systemPrisma.flowDispatchOutbox.findFirst({
    where: { id: outboxId, flowRunId, status: { in: ['published', 'consumed'] } },
  })
}
