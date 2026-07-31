/** Cursor-checkpointed historical activity backfill. */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { getActivitySource } from './registry'
import { ingestActivity } from './ingest'
import type { BackfillBatch, BackfillWindow, NormalizedActivity } from './types'
import { inferActivityPatterns } from '@/lib/intelligence/infer-patterns'

export const INLINE_BACKFILL_MAX_BATCHES = 15

export interface BackfillLoopResult {
  status: 'done' | 'partial' | 'failed'
  batches: number
  events: number
  /** Real failure cause (status 'failed' only) — persisted on the row. */
  error?: string
}

export async function runBackfillLoop(deps: {
  iterator: AsyncIterable<BackfillBatch>
  ingest: (events: NormalizedActivity[]) => Promise<void>
  checkpoint: (cursor: string | null, eventCount: number) => Promise<void>
  maxBatches?: number
}): Promise<BackfillLoopResult> {
  let batches = 0
  let events = 0
  try {
    for await (const batch of deps.iterator) {
      await deps.ingest(batch.events)
      batches++
      events += batch.events.length
      await deps.checkpoint(batch.nextCursor ?? null, events)
      if (!batch.nextCursor) return { status: 'done', batches, events }
      if (deps.maxBatches && batches >= deps.maxBatches) return { status: 'partial', batches, events }
    }
    return { status: 'done', batches, events }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    apiLogger.warn('activity.backfill loop failed', { error: message })
    // Carry the REAL cause: persisting a constant string discarded the only
    // signal distinguishing a revoked OAuth grant from a 429 from a schema
    // change — undiagnosable from the UI or the DB.
    return { status: 'failed', batches, events, error: message }
  }
}

export async function runActivityBackfill(backfillId: string, opts: { maxBatches?: number } = {}): Promise<void> {
  const row = await systemPrisma.activityBackfill.findUnique({ where: { id: backfillId } })
  if (!row || row.status === 'done') return
  const adapter = getActivitySource(row.source)
  if (!adapter?.capabilities.backfill) return

  await prisma.activityBackfill.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'running', startedAt: row.startedAt ?? new Date(), error: null },
  })
  const result = await runBackfillLoop({
    iterator: adapter.backfill(
      { organizationId: row.organizationId, connectionRef: row.connectionRef },
      row.window as BackfillWindow,
      row.cursor ?? undefined,
    ),
    ingest: async (events) => { await ingestActivity(row.organizationId, 'backfill', events) },
    checkpoint: async (cursor, count) => {
      await prisma.activityBackfill.update({
        where: { id: row.id, organizationId: row.organizationId },
        data: { cursor, eventsIngested: row.eventsIngested + count },
      })
    },
    ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
  })

  await prisma.activityBackfill.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: {
      status: result.status,
      ...(result.status === 'done' ? { completedAt: new Date() } : {}),
      ...(result.status === 'failed'
        ? { error: `${(result.error ?? 'backfill batch failed').slice(0, 280)} — retry resumes from checkpoint` }
        : {}),
    },
  })
  if (result.status === 'done') {
    void inferActivityPatterns(row.organizationId).catch(() => undefined)
    // Persona refresh: a completed historical backfill is exactly the signal
    // the persona's activity weighting exists for. Debounced internally.
    void import('@/lib/persona/compute')
      .then((mod) => mod.recomputeOrgPersona(row.organizationId))
      .catch(() => undefined)
  }
}

export async function startActivityBackfill(params: {
  organizationId: string
  source: string
  connectionRef: string
  window: BackfillWindow
}): Promise<{ backfillId: string; mode: 'queued' | 'inline-partial' }> {
  const row = await prisma.activityBackfill.upsert({
    where: {
      organizationId_source_connectionRef: {
        organizationId: params.organizationId,
        source: params.source,
        connectionRef: params.connectionRef,
      },
    },
    create: { ...params },
    update: { window: params.window, status: 'pending', cursor: null, eventsIngested: 0, error: null, completedAt: null },
  })
  if (!inlineExecution && workersEnabled) {
    const queue = getQueue(QUEUE_NAMES.ACTIVITY_BACKFILL)
    // Clear any finished job record first: BullMQ's jobId dedup treats a
    // completed/failed record still inside the removeOnComplete window as "this
    // job exists" and silently drops the re-enqueue — a user's retry after
    // reconnecting a revoked token left the row 'pending' forever. An ACTIVE
    // job can't be removed (locked), and then the dedup drop is correct.
    await queue.remove(row.id).catch(() => undefined)
    await queue.add('activity-backfill', { backfillId: row.id }, { jobId: row.id })
    return { backfillId: row.id, mode: 'queued' }
  }
  void runActivityBackfill(row.id, { maxBatches: INLINE_BACKFILL_MAX_BATCHES }).catch((error) =>
    apiLogger.warn('activity.backfill inline run failed', {
      backfillId: row.id,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return { backfillId: row.id, mode: 'inline-partial' }
}

export async function executeActivityBackfillJob(job: { data: { backfillId: string } }): Promise<void> {
  await runActivityBackfill(job.data.backfillId)
}
