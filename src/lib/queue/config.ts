import IORedis from 'ioredis'
import { Queue, type QueueOptions, type WorkerOptions } from 'bullmq'

export const QUEUE_NAMES = {
  AGENT_EXECUTION: 'agent-execution',
  SCHEDULED_AGENT_EXECUTION: 'scheduled-agent-execution',
  // Poison jobs land here after their single attempt fails, so a failed run is
  // durably inspectable (and re-runnable by an operator) instead of vanishing.
  // We do NOT auto-retry: agent runs have external side effects.
  DEAD_LETTER: 'agent-dead-letter',
} as const

const buildPhase = process.env.NEXT_PHASE === 'phase-production-build'
export const workersEnabled = process.env.BULLMQ_DISABLE !== 'true' && !buildPhase

let connection: IORedis | null = null

export function getRedisConnection() {
  if (!workersEnabled) throw new Error('BullMQ is disabled')
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required for the worker runtime')
  connection ??= new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  })
  return connection
}

export const workerConfig = {
  concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY) || 3,
  // Agent runs are long (multi-turn) with external side effects. The lock is
  // held long enough that a live run isn't declared stalled. A retry/stall
  // recovery is now SAFE because runAgentExecution checkpoints the transcript
  // per turn and resumes from the last completed turn (not from the top), and
  // already-completed tool calls are replayed from the step ledger instead of
  // re-fired — so we allow one stall recovery.
  lockDuration: 300_000,
  maxStalledCount: 1,
} satisfies Partial<WorkerOptions>

export function createQueue(name: string, overrides: Partial<QueueOptions> = {}) {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      // One retry: durable resume means a retry continues from the last
      // checkpointed turn and replays completed side effects as no-ops, so a
      // transient failure recovers instead of dead-lettering the whole run.
      attempts: 2,
      backoff: { type: 'fixed', delay: 2_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
    ...overrides,
  })
}
