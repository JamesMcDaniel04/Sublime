import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'

export type HealthDetails = {
  status: 'ok' | 'unhealthy'
  timestamp: string
  checks: Record<string, unknown>
}

export async function collectHealthDetails(): Promise<HealthDetails> {
  const [db, cache, neo4j, queue] = await Promise.all([
    probe(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
    queuePing(),
  ])
  return {
    status: db.ok ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks: { db, cache, neo4j, queue },
  }
}

async function probe(fn: () => Promise<void>): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const start = Date.now()
  try {
    await fn()
    return { ok: true, ms: Date.now() - start }
  } catch (error) {
    // Detailed output is exposed only through the authenticated system route.
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function queuePing(): Promise<{
  ok: boolean
  configured: boolean
  waiting?: number
  failed?: number
  deadLetters?: number
}> {
  if (!workersEnabled || !process.env.REDIS_URL) return { ok: false, configured: false }
  try {
    const liveQueues = [
      QUEUE_NAMES.AGENT_EXECUTION,
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
      QUEUE_NAMES.FLOW_EXECUTION,
      QUEUE_NAMES.ACTIVITY_BACKFILL,
    ]
    const [counts, agentDlq, flowDlq] = await Promise.all([
      Promise.all(liveQueues.map((name) => getQueue(name).getJobCounts('waiting', 'failed'))),
      getQueue(QUEUE_NAMES.DEAD_LETTER).getJobCounts('wait'),
      getQueue(QUEUE_NAMES.FLOW_DEAD_LETTER).getJobCounts('wait'),
    ])
    return {
      ok: true,
      configured: true,
      waiting: counts.reduce((sum, c) => sum + (c.waiting ?? 0), 0),
      failed: counts.reduce((sum, c) => sum + (c.failed ?? 0), 0),
      deadLetters: (agentDlq.wait ?? 0) + (flowDlq.wait ?? 0),
    }
  } catch {
    return { ok: false, configured: true }
  }
}
