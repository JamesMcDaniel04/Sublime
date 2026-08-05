/**
 * Worker liveness heartbeat. The worker runtime writes a timestamp key to the
 * SAME Redis it consumes; producers read it before enqueueing so a run is
 * never stranded `running` in a queue nothing drains (the failure mode that
 * left flows stuck on "Thinking…" for weeks: worker never deployed, every
 * dispatch enqueued into the void). A fresh beat also proves producer and
 * consumer share one Redis — a split-brain (two Redis instances that never
 * meet) reads as offline from the producer's side.
 */

export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat'
/** How often the worker re-beats. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000
/** Key TTL — 3 missed beats and the key expires on its own. */
export const WORKER_HEARTBEAT_TTL_S = 180
/**
 * Producer-side staleness cutoff. 3× the beat interval: one missed beat is a
 * GC pause or restart; three means nothing is consuming.
 */
export const WORKER_HEARTBEAT_STALE_MS = 3 * WORKER_HEARTBEAT_INTERVAL_MS

/** The two Redis commands the heartbeat needs — keeps tests dependency-free. */
type HeartbeatWriter = { set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown> }
type HeartbeatReader = { get(key: string): Promise<string | null> }

export type WorkerLiveness = { alive: boolean; ageMs: number | null }

export async function writeWorkerHeartbeat(redis: HeartbeatWriter, now: number = Date.now()): Promise<void> {
  await redis.set(WORKER_HEARTBEAT_KEY, String(now), 'EX', WORKER_HEARTBEAT_TTL_S)
}

/** Ms since the last beat, or null when absent/unparseable. */
export async function workerHeartbeatAgeMs(redis: HeartbeatReader, now: number = Date.now()): Promise<number | null> {
  const raw = await redis.get(WORKER_HEARTBEAT_KEY)
  if (!raw) return null
  const beat = Number(raw)
  if (!Number.isFinite(beat)) return null
  return Math.max(0, now - beat)
}

/**
 * Never throws: an unreachable Redis reads as offline, which is the correct
 * dispatch decision either way (the enqueue would fail too).
 */
export async function checkWorkerLiveness(redis: HeartbeatReader, now: number = Date.now()): Promise<WorkerLiveness> {
  try {
    const ageMs = await workerHeartbeatAgeMs(redis, now)
    return { alive: ageMs !== null && ageMs <= WORKER_HEARTBEAT_STALE_MS, ageMs }
  } catch {
    return { alive: false, ageMs: null }
  }
}

/**
 * Production glue for dispatch paths: liveness via the bounded producer
 * connection. Wraps connection ACQUISITION too (REDIS_URL unset/invalid), so
 * callers get a plain "offline" instead of a throw.
 */
export async function checkFlowWorkerLiveness(): Promise<WorkerLiveness> {
  try {
    const { getProducerConnection } = await import('./config')
    return await checkWorkerLiveness(getProducerConnection())
  } catch {
    return { alive: false, ageMs: null }
  }
}
