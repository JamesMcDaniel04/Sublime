import IORedis from 'ioredis'
import { Queue, type QueueOptions, type WorkerOptions } from 'bullmq'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { captureError } from '@/lib/observability/sentry'

export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
  // Poison jobs land here after their single attempt fails, so a failed run is
  // durably inspectable (and re-runnable by an operator) instead of vanishing.
  // We do NOT auto-retry: agent runs have external side effects.
  DEAD_LETTER: 'agent-dead-letter',
  FLOW_EXECUTION: 'flow-execution',
  FLOW_DEAD_LETTER: 'flow-dead-letter',
  ACTIVITY_BACKFILL: 'activity-backfill',
} as const

const buildPhase = process.env.NEXT_PHASE === 'phase-production-build'
export const workersEnabled = process.env.BULLMQ_DISABLE !== 'true' && !buildPhase

function requireRedisUrl(): string {
  if (!workersEnabled) throw new Error('BullMQ is disabled')
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for the worker runtime')
  return process.env.REDIS_URL
}

// Redis 'error' fires on every failed reconnect attempt; report at most one
// per minute per connection so an outage doesn't flood Sentry.
function attachErrorReporting(conn: IORedis, role: 'worker' | 'producer') {
  let lastReport = 0
  conn.on('error', (error) => {
    const now = Date.now()
    if (now - lastReport < 60_000) return
    lastReport = now
    captureError(error, { source: `redis.${role}` })
  })
}

let workerConnection: IORedis | null = null
let producerConnection: IORedis | null = null

/**
 * Blocking connection for BullMQ Workers ONLY. Workers REQUIRE
 * `maxRetriesPerRequest: null` (they hold long-lived blocking commands), which
 * also means any command on this connection retries forever and never rejects.
 * Producers (queue.add from request handlers) must NEVER use it — a degraded
 * Redis would hang the request for the function's full maxDuration.
 */
export function getRedisConnection() {
  const url = requireRedisUrl()
  if (!workerConnection) {
    workerConnection = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    })
    attachErrorReporting(workerConnection, 'worker')
  }
  return workerConnection
}

/**
 * Bounded connection for producers (queue.add from API routes, the cron
 * dispatcher, and dead-letter capture). Commands reject after 2 reconnect
 * attempts / 5s instead of retrying forever, so a Redis outage surfaces as a
 * fast, catchable error (letting the caller mark the execution failed) rather
 * than a lambda hung until the platform kills it.
 */
export function getProducerConnection() {
  const url = requireRedisUrl()
  if (!producerConnection) {
    producerConnection = new IORedis(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      enableReadyCheck: true,
      lazyConnect: true,
    })
    attachErrorReporting(producerConnection, 'producer')
  }
  return producerConnection
}

const agentConcurrency = Number(process.env.AGENT_WORKER_CONCURRENCY) || 10
// Agent/flow runs are ~100% I/O-wait (model + tool calls), so per-queue
// concurrency is deliberately higher than CPU count. The worker's
// DATABASE_URL connection_limit must cover the sum of these (see render.yaml).
export const queueConcurrency: Record<string, number> = {
  [QUEUE_NAMES.AGENT_EXECUTION]: agentConcurrency,
  [QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION]: agentConcurrency,
  [QUEUE_NAMES.FLOW_EXECUTION]: Number(process.env.FLOW_WORKER_CONCURRENCY) || agentConcurrency,
  [QUEUE_NAMES.ACTIVITY_BACKFILL]: Number(process.env.BACKFILL_WORKER_CONCURRENCY) || 2,
}

export const workerConfig = {
  concurrency: agentConcurrency,
  // Agent runs are long (multi-turn) with external side effects. The lock is
  // held long enough that a live run isn't declared stalled. A retry/stall
  // recovery is now SAFE because runAgentExecution checkpoints the transcript
  // per turn and resumes from the last completed turn (not from the top), and
  // already-completed tool calls are replayed from the step ledger instead of
  // re-fired — so we allow one stall recovery.
  lockDuration: AGENT_RUN_TIMEOUT_MS,
  maxStalledCount: 1,
} satisfies Partial<WorkerOptions>

const defaultJobOptions: QueueOptions['defaultJobOptions'] = {
  // One retry: durable resume means a retry continues from the last
  // checkpointed turn and replays completed side effects as no-ops, so a
  // transient failure recovers instead of dead-lettering the whole run.
  attempts: 2,
  backoff: { type: 'fixed', delay: 2_000 },
  removeOnComplete: 100,
  removeOnFail: 100,
}

const queues = new Map<string, Queue>()

/**
 * Process-wide Queue singleton per name, on the bounded producer connection.
 * A Queue attaches listeners to its connection and is never GC'd while
 * referenced — constructing one per request (the previous createQueue pattern)
 * leaked listeners and queue objects until the warm instance OOM'd. Never
 * close() these; they live for the process.
 */
export function getQueue(name: string): Queue {
  let queue = queues.get(name)
  if (!queue) {
    queue = new Queue(name, {
      connection: getProducerConnection(),
      defaultJobOptions,
    })
    queues.set(name, queue)
  }
  return queue
}
