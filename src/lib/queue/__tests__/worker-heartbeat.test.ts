import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_S,
  WORKER_HEARTBEAT_STALE_MS,
  writeWorkerHeartbeat,
  workerHeartbeatAgeMs,
  checkWorkerLiveness,
} from '../worker-heartbeat'

// Minimal in-memory stand-in for the two Redis commands the heartbeat uses.
function fakeRedis(store = new Map<string, string>()) {
  const calls: { set?: { key: string; value: string; mode: string; ttl: number } } = {}
  return {
    calls,
    store,
    async set(key: string, value: string, mode: string, ttl: number) {
      store.set(key, String(value))
      calls.set = { key, value: String(value), mode, ttl }
      return 'OK'
    },
    async get(key: string) {
      return store.get(key) ?? null
    },
  }
}

test('writeWorkerHeartbeat stores the current timestamp under a TTL', async () => {
  const redis = fakeRedis()
  await writeWorkerHeartbeat(redis, 1_000)
  assert.equal(redis.store.get(WORKER_HEARTBEAT_KEY), '1000')
  assert.deepEqual(redis.calls.set, { key: WORKER_HEARTBEAT_KEY, value: '1000', mode: 'EX', ttl: WORKER_HEARTBEAT_TTL_S })
})

test('workerHeartbeatAgeMs returns elapsed ms since the recorded beat', async () => {
  const redis = fakeRedis()
  await writeWorkerHeartbeat(redis, 1_000)
  assert.equal(await workerHeartbeatAgeMs(redis, 6_000), 5_000)
})

test('workerHeartbeatAgeMs is null when no beat has ever been written', async () => {
  assert.equal(await workerHeartbeatAgeMs(fakeRedis(), 6_000), null)
})

test('workerHeartbeatAgeMs is null when the stored value is not a timestamp', async () => {
  const redis = fakeRedis()
  redis.store.set(WORKER_HEARTBEAT_KEY, 'garbage')
  assert.equal(await workerHeartbeatAgeMs(redis, 6_000), null)
})

test('checkWorkerLiveness reports alive for a fresh beat', async () => {
  const redis = fakeRedis()
  await writeWorkerHeartbeat(redis, 1_000)
  assert.deepEqual(await checkWorkerLiveness(redis, 1_000 + WORKER_HEARTBEAT_STALE_MS - 1), {
    alive: true,
    ageMs: WORKER_HEARTBEAT_STALE_MS - 1,
  })
})

test('checkWorkerLiveness reports offline for a stale beat', async () => {
  const redis = fakeRedis()
  await writeWorkerHeartbeat(redis, 1_000)
  assert.deepEqual(await checkWorkerLiveness(redis, 1_000 + WORKER_HEARTBEAT_STALE_MS + 1), {
    alive: false,
    ageMs: WORKER_HEARTBEAT_STALE_MS + 1,
  })
})

test('checkWorkerLiveness reports offline when the beat is absent', async () => {
  assert.deepEqual(await checkWorkerLiveness(fakeRedis(), 9_999), { alive: false, ageMs: null })
})

test('checkWorkerLiveness never throws — a Redis error reads as offline', async () => {
  const broken = {
    async get(): Promise<string | null> {
      throw new Error('ECONNREFUSED')
    },
  }
  assert.deepEqual(await checkWorkerLiveness(broken, 9_999), { alive: false, ageMs: null })
})
