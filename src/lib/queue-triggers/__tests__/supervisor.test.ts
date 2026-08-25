/**
 * The consumer supervisor: the part that makes pull-based queue triggers a
 * worker feature rather than a node.
 *
 * A broker consumer is not a request. It is a long-lived connection that must
 * survive the broker restarting, must not acknowledge a message before the
 * work is safe, must not read faster than it can process, and must drain
 * rather than drop when the worker shuts down. Those four properties are what
 * this file exists for, and they are driver-independent — so they are tested
 * against a fake driver where every failure can actually be provoked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConsumerSupervisor } from '../supervisor'
import { FakeQueueDriver } from './fake-driver'

const binding = {
  id: 'b1',
  flowId: 'flow-1',
  organizationId: 'org-1',
  userId: 'user-1',
  broker: 'fake' as const,
  url: 'fake://queue',
  topic: 'orders',
}

/** A supervisor wired to a fake driver, with immediate backoff for tests. */
function harness(overrides: Partial<ConstructorParameters<typeof ConsumerSupervisor>[0]> = {}) {
  const driver = new FakeQueueDriver()
  const delivered: unknown[] = []
  const supervisor = new ConsumerSupervisor({
    createDriver: () => driver,
    onMessage: async (message) => { delivered.push(message.body) },
    backoffMs: () => 0,
    ...overrides,
  })
  return { driver, delivered, supervisor }
}

// ── delivery ────────────────────────────────────────────────────────────────

test('a message reaches the handler', async () => {
  const { driver, delivered, supervisor } = harness()
  await supervisor.start([binding])
  await driver.deliver({ id: 'm1', body: { order: 1 } })
  await supervisor.stop()
  assert.deepEqual(delivered, [{ order: 1 }])
})

// The core correctness rule for at-least-once delivery: acknowledging before
// the work is durable means a crash loses the message silently.
test('a message is acknowledged only after it is handled', async () => {
  const order: string[] = []
  const { driver, supervisor } = harness({
    onMessage: async () => { order.push('handled') },
  })
  driver.onAck = () => order.push('acked')
  await supervisor.start([binding])
  await driver.deliver({ id: 'm1', body: {} })
  await supervisor.stop()
  assert.deepEqual(order, ['handled', 'acked'])
})

// A failed handler must NOT ack — the broker has to redeliver, or the message
// is lost with no record that it ever existed.
test('a failed message is not acknowledged', async () => {
  const { driver, supervisor } = harness({
    onMessage: async () => { throw new Error('handler blew up') },
  })
  await supervisor.start([binding])
  await driver.deliver({ id: 'm1', body: {} })
  await supervisor.stop()
  assert.deepEqual(driver.acked, [])
  assert.deepEqual(driver.nacked, ['m1'])
})

// One poisoned message must not stop the consumer.
test('a failing message does not stop later ones', async () => {
  const seen: string[] = []
  const { driver, supervisor } = harness({
    onMessage: async (message) => {
      seen.push(message.id)
      if (message.id === 'bad') throw new Error('poison')
    },
  })
  await supervisor.start([binding])
  await driver.deliver({ id: 'bad', body: {} })
  await driver.deliver({ id: 'good', body: {} })
  await supervisor.stop()
  assert.deepEqual(seen, ['bad', 'good'])
})

// ── backpressure ────────────────────────────────────────────────────────────
//
// Without a ceiling, a backlog of 100k messages is read into memory as fast as
// the broker will serve it and the worker dies — taking every other queue and
// every in-flight flow run with it.

test('no more than the configured messages are in flight at once', async () => {
  let inFlight = 0
  let peak = 0
  const release: (() => void)[] = []
  const { driver, supervisor } = harness({
    maxInFlight: 2,
    onMessage: async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => release.push(() => { inFlight--; resolve() }))
    },
  })
  await supervisor.start([binding])

  const deliveries = Promise.all(
    ['m1', 'm2', 'm3', 'm4'].map((id) => driver.deliver({ id, body: {} })),
  )
  // Let the first batch occupy the window.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peak, 2, `peak in-flight was ${peak}`)

  release.forEach((fn) => fn())
  await new Promise((resolve) => setImmediate(resolve))
  release.forEach((fn) => fn())
  await deliveries
  await supervisor.stop()
  assert.equal(peak, 2, 'the in-flight ceiling was exceeded')
})

// ── reconnection ────────────────────────────────────────────────────────────

test('a dropped connection is reopened', async () => {
  const { driver, supervisor } = harness()
  await supervisor.start([binding])
  assert.equal(driver.connectCount, 1)

  await driver.dropConnection()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(driver.connectCount > 1, 'the consumer did not reconnect')
  await supervisor.stop()
})

// A broker that is down must not be retried in a tight loop — that is a
// self-inflicted denial of service on someone else's infrastructure.
test('reconnection backs off rather than spinning', async () => {
  const delays: number[] = []
  const driver = new FakeQueueDriver()
  driver.failConnectTimes = 3
  const supervisor = new ConsumerSupervisor({
    createDriver: () => driver,
    onMessage: async () => {},
    backoffMs: (attempt) => { delays.push(attempt); return 0 },
  })
  await supervisor.start([binding])
  await new Promise((resolve) => setTimeout(resolve, 20))
  await supervisor.stop()
  // Attempts increase, so the delay derived from them does too.
  assert.ok(delays.length >= 2, `only ${delays.length} retries were attempted`)
  assert.ok(delays[1] > delays[0], 'the backoff did not grow')
})

// ── isolation ───────────────────────────────────────────────────────────────

test('one broken binding does not stop the others', async () => {
  const drivers = new Map<string, FakeQueueDriver>()
  const delivered: string[] = []
  const supervisor = new ConsumerSupervisor({
    createDriver: (b) => {
      const driver = new FakeQueueDriver()
      if (b.id === 'broken') driver.failConnectTimes = Infinity
      drivers.set(b.id, driver)
      return driver
    },
    onMessage: async (message) => { delivered.push(message.id) },
    backoffMs: () => 0,
  })

  await supervisor.start([
    { ...binding, id: 'broken', topic: 'a' },
    { ...binding, id: 'working', topic: 'b' },
  ])
  await drivers.get('working')!.deliver({ id: 'm1', body: {} })
  await supervisor.stop()
  assert.deepEqual(delivered, ['m1'])
})

// ── shutdown ────────────────────────────────────────────────────────────────

// A worker redeploys constantly. Dropping in-flight work on every deploy would
// make the queue trigger unreliable by design.
test('stopping drains in-flight work rather than dropping it', async () => {
  let finished = false
  const { driver, supervisor } = harness({
    onMessage: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      finished = true
    },
  })
  await supervisor.start([binding])
  const inFlight = driver.deliver({ id: 'm1', body: {} })
  await supervisor.stop()
  await inFlight
  assert.equal(finished, true, 'shutdown dropped in-flight work')
  assert.deepEqual(driver.acked, ['m1'])
})

test('stopping closes every driver', async () => {
  const { driver, supervisor } = harness()
  await supervisor.start([binding])
  await supervisor.stop()
  assert.equal(driver.closed, true)
})

test('a message arriving after stop is ignored', async () => {
  const { driver, delivered, supervisor } = harness()
  await supervisor.start([binding])
  await supervisor.stop()
  await driver.deliver({ id: 'm1', body: {} })
  assert.deepEqual(delivered, [])
})

test('starting twice does not double-subscribe', async () => {
  const { driver, delivered, supervisor } = harness()
  await supervisor.start([binding])
  await supervisor.start([binding])
  await driver.deliver({ id: 'm1', body: {} })
  await supervisor.stop()
  assert.equal(delivered.length, 1, 'the message was handled twice')
})
