import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { getQueue, getProducerConnection, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { checkWorkerLiveness } from '@/lib/queue/worker-heartbeat'
import { getProductReadiness } from '@/lib/env'
import { degradedSubsystems, type Degradation } from '@/lib/health/degradations'
import { apiLogger } from '@/lib/logger'

export type HealthDetails = {
  status: 'ok' | 'unhealthy'
  timestamp: string
  checks: Record<string, unknown>
  /**
   * Subsystems serving in a fallback mode. Deliberately NOT part of `status`:
   * a degraded cache still serves traffic, and failing the load-balancer probe
   * over it would turn "billing ceilings are per-instance" into "the site is
   * down". It is reported so it stops being invisible.
   */
  degraded: Degradation[]
}

export async function collectHealthDetails(): Promise<HealthDetails> {
  const configuration = getProductReadiness()
  const [db, cache, neo4j, queue] = await Promise.all([
    probeWithDeadline(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
    queuePing(),
  ])
  const degraded = degradedSubsystems(process.env, { cacheReachable: cache.ok })
  if (degraded.length > 0 && process.env.NODE_ENV === 'production') {
    // Error level, not warn: each entry means a feature the product claims is
    // silently absent. Without this the only symptom is a user noticing.
    apiLogger.error('health: subsystems running degraded', {
      degraded: degraded.map((entry) => entry.key),
    })
  }
  return {
    status: db.ok && configuration.ok ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: { db, configuration, cache, neo4j, queue },
    degraded,
  }
}

/**
 * How long a dependency gets to answer before it is called unhealthy.
 *
 * A liveness probe MUST bound its own wait. When the Postgres pool saturates,
 * `SELECT 1` blocks on a connection checkout that only gives up after 60s — so
 * an unbounded probe either hangs until the platform kills the request or wins
 * a lucky slot and reports healthy while every real request is failing. That is
 * exactly what happened on 2026-08-19: /api/health returned 200 in the same
 * second that /api/bootstrap returned 500 and /api/agents returned 401, all
 * from the same exhausted pool.
 */
const PROBE_DEADLINE_MS = 2_000

/** Run a dependency check under a deadline. Never throws. */
export async function probeWithDeadline(
  fn: () => Promise<void>,
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const start = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${deadlineMs}ms`)), deadlineMs)
      }),
    ])
    return { ok: true, ms: Date.now() - start }
  } catch (error) {
    // Detailed output is exposed only through the authenticated system route.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    // The losing promise keeps the event loop alive without this.
    if (timer) clearTimeout(timer)
  }
}

async function queuePing(): Promise<{
  ok: boolean
  configured: boolean
  waiting?: number
  failed?: number
  deadLetters?: number
  workerAlive?: boolean
  workerHeartbeatAgeMs?: number | null
}> {
  if (!workersEnabled || !process.env.REDIS_URL) return { ok: false, configured: false }
  try {
    const liveQueues = [
      QUEUE_NAMES.AGENT_EXECUTION,
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
      QUEUE_NAMES.FLOW_EXECUTION,
      QUEUE_NAMES.ACTIVITY_BACKFILL,
    ]
    const [counts, agentDlq, flowDlq, liveness] = await Promise.all([
      Promise.all(liveQueues.map((name) => getQueue(name).getJobCounts('waiting', 'failed'))),
      getQueue(QUEUE_NAMES.DEAD_LETTER).getJobCounts('wait'),
      getQueue(QUEUE_NAMES.FLOW_DEAD_LETTER).getJobCounts('wait'),
      // A reachable queue with NO consumer is the outage that strands runs —
      // surface it so uptime monitors (and the builder banner) can alert.
      checkWorkerLiveness(getProducerConnection()),
    ])
    return {
      ok: true,
      configured: true,
      waiting: counts.reduce((sum, c) => sum + (c.waiting ?? 0), 0),
      failed: counts.reduce((sum, c) => sum + (c.failed ?? 0), 0),
      deadLetters: (agentDlq.wait ?? 0) + (flowDlq.wait ?? 0),
      workerAlive: liveness.alive,
      workerHeartbeatAgeMs: liveness.ageMs,
    }
  } catch {
    return { ok: false, configured: true }
  }
}
