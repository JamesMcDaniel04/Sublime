import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { getQueue, getProducerConnection, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { checkWorkerLiveness } from '@/lib/queue/worker-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Readiness probe. Postgres is the only CRITICAL dependency for serving — if
 * it's down we return 503 so load balancers / deploy gates / uptime monitors
 * see the outage. The cache (Redis) and Neo4j degrade gracefully (best-effort
 * RAG + fall-through cache), so they're reported but never fail the check.
 *
 * The queue check covers the BullMQ Redis (the single point of failure for
 * all async execution) and surfaces waiting/failed/dead-letter depths so an
 * uptime monitor can alert on backlog growth — previously a total queue
 * outage returned 200 with no signal anywhere.
 *
 * The response is cached per instance for 10s: this endpoint is
 * unauthenticated, and uncached it was a free amplification vector (every
 * request probed four external services).
 */

type HealthBody = {
  status: string
  timestamp: string
  checks: Record<string, unknown>
}

let cached: { at: number; body: HealthBody; httpStatus: number } | null = null
const HEALTH_CACHE_MS = 10_000

export async function GET() {
  if (cached && Date.now() - cached.at < HEALTH_CACHE_MS) {
    return NextResponse.json(cached.body, { status: cached.httpStatus })
  }

  const [db, cache, neo4j, queue] = await Promise.all([
    probe(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
    queuePing(),
  ])

  const healthy = db.ok // only Postgres is critical to serving
  const body: HealthBody = {
    status: healthy ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: { db, cache, neo4j, queue },
  }
  const httpStatus = healthy ? 200 : 503
  cached = { at: Date.now(), body, httpStatus }
  return NextResponse.json(body, { status: httpStatus })
}

async function probe(fn: () => Promise<void>): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const start = Date.now()
  try {
    await fn()
    return { ok: true, ms: Date.now() - start }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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
    // Producer connection commands are bounded at 5s, so a dead Redis can't
    // hang this probe.
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
