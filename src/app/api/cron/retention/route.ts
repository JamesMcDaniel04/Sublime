/**
 * /api/cron/retention — daily pruning of unbounded-growth tables.
 *
 * Deletes agent executions older than RETENTION_DAYS (default 90).
 * Deleting an execution cascades its workflow steps/events/messages. Audit
 * events are intentionally NOT pruned (append-only for compliance). Capped per
 * run so a backlog is worked down over successive days rather than in one huge
 * transaction.
 *
 * Auth (fail closed): requires Authorization: Bearer <CRON_SECRET>.
 */

import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { removeRetiredFromGraph } from '@/lib/rag/indexer'
import { removeUserEventNodesFromGraph } from '@/lib/behavior/index-user-event'
import { MAX_STALE_DAYS } from '@/lib/behavior/eligibility'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const CAP = 5000
// Canonical knowledge promotion performs encryption/chunking (and may embed),
// so keep this leg bounded independently from cheap row pruning.
const KNOWLEDGE_PROMOTION_CAP = 250

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  const days = Number(process.env.RETENTION_DAYS) || 90
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  try {
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleExecutions = await systemPrisma.agentExecution.findMany({
      where: { startedAt: { lt: cutoff } },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        agentTaskId: true,
        agentType: true,
        status: true,
        input: true,
        output: true,
        error: true,
        startedAt: true,
        completedAt: true,
        agentTask: { select: { description: true, objective: true } },
      },
      take: KNOWLEDGE_PROMOTION_CAP,
    })
    // Promote operational history into the encrypted knowledge substrate
    // BEFORE pruning it. A failed promotion leaves the execution in place so
    // transient storage/embedding problems cannot silently destroy value.
    const deletableExecutions: typeof staleExecutions = []
    let knowledgePromoted = 0
    const { storeKnowledge } = await import('@/lib/knowledge/store')
    for (const execution of staleExecutions) {
      try {
        const captured = await storeKnowledge({
          organizationId: execution.organizationId,
          userId: execution.userId,
          agentId: execution.agentTaskId,
          sourceType: 'agent_run',
          sourceId: execution.id,
          title: `${execution.agentTask?.description || execution.agentType} — retained run`,
          filename: `agent-runs/${execution.agentTaskId || 'unlinked'}/${execution.id}.md`,
          visibility: 'private',
          content: {
            objective: execution.agentTask?.objective,
            input: execution.input,
            output: execution.output,
            status: execution.status,
            error: execution.error,
            startedAt: execution.startedAt,
            completedAt: execution.completedAt,
          },
          provenance: { executionId: execution.id, kind: 'retention-promotion' },
        })
        // Explicit zero-retention/capture opt-out authorizes normal pruning;
        // otherwise only a successfully stored document is deletable.
        if (captured.stored || captured.reason === 'zero-data-retention' || captured.reason === 'capture-disabled') {
          deletableExecutions.push(execution)
          if (captured.stored) knowledgePromoted += 1
        }
      } catch (error) {
        apiLogger.warn('cron/retention: knowledge promotion failed; keeping execution', {
          executionId: execution.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // Graph parity: prune the run: nodes for the rows this sweep is
    // about to delete — graph-first, because after the Postgres delete the
    // ids are gone and a missed node would linger forever (audit: deleted
    // PII resurfacing in RAG context).
    const graphGroups = new Map<string, { organizationId: string; executionIds: string[] }>()
    for (const e of deletableExecutions) {
      const group = graphGroups.get(e.organizationId) ?? { organizationId: e.organizationId, executionIds: [] }
      group.executionIds.push(e.id)
      graphGroups.set(e.organizationId, group)
    }
    // Graph-first is a hard ordering, not a preference: if the graph cleanup
    // fails, the Postgres rows MUST survive this sweep too (they retry
    // tomorrow). Deleting anyway would orphan run: nodes whose ids are gone —
    // the exact "deleted PII resurfacing in RAG context" incident class.
    let executionsDeleted = 0
    try {
      await removeRetiredFromGraph(Array.from(graphGroups.values()))
      // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
      executionsDeleted = deletableExecutions.length
        ? (await systemPrisma.agentExecution.deleteMany({ where: { id: { in: deletableExecutions.map((e) => e.id) } } })).count
        : 0
    } catch (error) {
      apiLogger.error('cron/retention: graph cleanup failed; keeping executions until it succeeds', {
        executions: deletableExecutions.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Transcripts are the fattest column (provider message JSON, growing per
    // turn — can reach MBs per run). They only matter for RESUMING a run, so
    // terminal runs older than TRANSCRIPT_RETENTION_DAYS (default 14) have
    // theirs nulled long before the row itself is deleted at RETENTION_DAYS.
    const transcriptDays = Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 14
    const transcriptCutoff = new Date(Date.now() - transcriptDays * 24 * 60 * 60 * 1000)
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleTranscripts = await systemPrisma.agentExecution.findMany({
      where: {
        completedAt: { lt: transcriptCutoff },
        // Every terminal status — 'cancelled' runs are finalized by the
        // dispatch reaper and can never resume, so their transcripts are
        // equally dead weight.
        status: { in: ['completed', 'failed', 'cancelled'] },
        NOT: { transcript: { equals: Prisma.DbNull } },
      },
      select: { id: true },
      take: CAP,
    })
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const transcriptsPruned = staleTranscripts.length
      ? (await systemPrisma.agentExecution.updateMany({
          where: { id: { in: staleTranscripts.map((e) => e.id) } },
          // The in-run plan artifact shares the transcript's lifecycle (its
          // schema comment promises "pruned with the run like the transcript"):
          // both only matter while a run could still be resumed or inspected.
          data: { transcript: Prisma.DbNull, plan: Prisma.DbNull },
        })).count
      : 0

    // user_events: 180-day ledger (patterns/graph distillations persist on
    // their own). Graph-first, same reasoning as executions above.
    const behaviorDays = Number(process.env.BEHAVIOR_RETENTION_DAYS) || 180
    const behaviorCutoff = new Date(Date.now() - behaviorDays * 24 * 60 * 60 * 1000)
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleUserEvents = await systemPrisma.userEvent.findMany({
      where: { occurredAt: { lt: behaviorCutoff } }, select: { id: true, organizationId: true }, take: CAP,
    })
    let userEventsDeleted = 0
    if (staleUserEvents.length > 0) {
      const eventGroups = new Map<string, { organizationId: string; eventIds: string[] }>()
      for (const e of staleUserEvents) {
        const group = eventGroups.get(e.organizationId) ?? { organizationId: e.organizationId, eventIds: [] }
        group.eventIds.push(e.id)
        eventGroups.set(e.organizationId, group)
      }
      // Same graph-first ordering as executions — and isolated, so a graph
      // outage here can't abort the rest of the sweep (re-embed, expiring
      // knowledge) the way an uncaught throw did.
      try {
        await removeUserEventNodesFromGraph(Array.from(eventGroups.values()))
        userEventsDeleted = (await systemPrisma.userEvent.deleteMany({
          where: { id: { in: staleUserEvents.map((e) => e.id) } },
        })).count
      } catch (error) {
        apiLogger.error('cron/retention: user-event graph cleanup failed; keeping events until it succeeds', {
          events: staleUserEvents.length,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Stale-pattern hygiene: the eligibility gate already rejects patterns not
    // observed within MAX_STALE_DAYS; this sweep makes that decay durable for
    // users who stopped triggering the daily inference (their rows would
    // otherwise sit "open" forever). Expired ≠ dismissed — recurrence re-opens.
    const staleCutoff = new Date(Date.now() - MAX_STALE_DAYS * 24 * 60 * 60 * 1000)
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const patternsExpired = (await systemPrisma.userPattern.updateMany({
      where: { status: 'open', lastSeenAt: { lt: staleCutoff } },
      data: { status: 'expired' },
    })).count

    // Nightly re-embed sweep: backfill vectors for rows written while
    // embeddings were unconfigured (or whose embed failed at write time), so
    // they become retrievable instead of staying invisible forever.
    // Bounded batch; a failure is retried tomorrow, never fails retention.
    const reEmbedded = await (await import('@/lib/rag/re-embed')).reEmbedMissingVectors()

    // Encryption hygiene: converge legacy plaintext / b64-fallback chunk rows
    // onto real AES-256-GCM so "encrypted knowledge" holds for pre-cutover
    // data too. Bounded; self-skips when no ENCRYPTION_KEY is configured.
    const encryptionBackfill = await (await import('@/lib/knowledge/encrypt-backfill')).encryptLegacyKnowledge()

    // Explicitly expiring knowledge is the only knowledge the general sweep
    // removes. Workspace-retained documents survive until a user deletes them
    // or the workspace cascade runs.
    const expiredKnowledgeDeleted = (await systemPrisma.knowledgeDocument.deleteMany({
      where: { retentionPolicy: 'expiring', expiresAt: { lt: new Date() } },
    })).count

    // Dead-letter queues have no consumer (they're an operator inbox), so
    // without pruning they grow in Redis until Upstash hits its memory cap and
    // every queue fails at once. Entries older than DLQ_RETENTION_DAYS have
    // had their operator window; the execution/flow-run rows remain in
    // Postgres under the normal retention policy.
    const deadLettersPruned = await cleanDeadLetterQueues()

    apiLogger.info('cron/retention complete', { days, executionsDeleted, knowledgePromoted, transcriptsPruned, userEventsDeleted, patternsExpired, reEmbedded, encryptionBackfill, expiredKnowledgeDeleted, deadLettersPruned })
    return Response.json({ success: true, days, executionsDeleted, knowledgePromoted, transcriptsPruned, userEventsDeleted, patternsExpired, reEmbedded, encryptionBackfill, expiredKnowledgeDeleted, deadLettersPruned })
  } catch (error) {
    apiLogger.error('cron/retention failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

async function cleanDeadLetterQueues(): Promise<number> {
  if (!workersEnabled || !process.env.REDIS_URL) return 0
  const dlqDays = Number(process.env.DLQ_RETENTION_DAYS) || 30
  const grace = dlqDays * 24 * 60 * 60 * 1000
  try {
    // DLQ entries are never processed, so they sit in 'wait' forever.
    const [agent, flow] = await Promise.all([
      getQueue(QUEUE_NAMES.DEAD_LETTER).clean(grace, 1000, 'wait'),
      getQueue(QUEUE_NAMES.FLOW_DEAD_LETTER).clean(grace, 1000, 'wait'),
    ])
    return agent.length + flow.length
  } catch (error) {
    apiLogger.error('cron/retention: dead-letter cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}
