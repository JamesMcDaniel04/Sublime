/**
 * Queue triggers, wired to real flows.
 *
 * Every broker here is at-least-once by design — that is what makes them
 * durable — so a redelivered message is expected rather than exceptional, and
 * dedupe is a correctness requirement. Tested against a real database because
 * the claim is a transaction with SELECT … FOR UPDATE, which an in-memory stub
 * would prove nothing about.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  test('queue triggers', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { queueBindings, runFlowForMessage } = await import('../queue-consumers')

    const seeded = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    const graph = { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'queue' } } }], edges: [] }
    const queueTrigger = { type: 'queue', broker: 'amqp', url: 'amqp://broker/', topic: 'orders' }

    const flow = await prisma.flow.create({
      data: {
        name: 'Order intake',
        organizationId: seeded.organizationId, userId: seeded.userId,
        trigger: queueTrigger, graph, publishedGraph: graph, status: 'ACTIVE',
      },
      select: { id: true },
    })

    const binding = {
      id: flow.id, flowId: flow.id,
      organizationId: seeded.organizationId, userId: seeded.userId,
      broker: 'amqp' as const, url: 'amqp://broker/', topic: 'orders',
    }

    const runCount = () => prisma.flowRun.count({
      where: { flowId: flow.id, organizationId: seeded.organizationId },
    })

    await t.test('a published queue flow becomes a binding', async () => {
      const bindings = await queueBindings()
      const found = bindings.find((entry) => entry.flowId === flow.id)
      assert.ok(found, 'the flow produced no binding')
      assert.equal(found.broker, 'amqp')
      assert.equal(found.topic, 'orders')
    })

    await t.test('a message runs the flow', async () => {
      await runFlowForMessage({ id: 'msg-1', body: { order: 1 } }, binding)
      assert.equal(await runCount(), 1)
    })

    // The load-bearing property: brokers redeliver, and a redelivery must not
    // run the flow again.
    await t.test('a redelivered message does not run the flow twice', async () => {
      await runFlowForMessage({ id: 'msg-1', body: { order: 1 } }, binding)
      assert.equal(await runCount(), 1, 'a redelivered message ran the flow twice')
    })

    // ...and it must return normally, so the supervisor ACKs it. Throwing
    // would nack it back to the broker forever.
    await t.test('a duplicate is accepted rather than rejected', async () => {
      await assert.doesNotReject(() => runFlowForMessage({ id: 'msg-1', body: {} }, binding))
    })

    await t.test('a genuinely new message runs the flow', async () => {
      await runFlowForMessage({ id: 'msg-2', body: { order: 2 } }, binding)
      assert.equal(await runCount(), 2)
    })

    // Two workers consuming the same queue is the normal deployment.
    await t.test('two workers cannot both run one message', async () => {
      await Promise.all([
        runFlowForMessage({ id: 'race-1', body: {} }, binding),
        runFlowForMessage({ id: 'race-1', body: {} }, binding),
      ])
      assert.equal(await runCount(), 3, 'a racing delivery ran the flow twice')
    })

    // ── which flows bind ────────────────────────────────────────────────────

    await t.test('an unpublished flow is not consumed from', async () => {
      const draft = await prisma.flow.create({
        data: {
          name: 'Draft consumer', organizationId: seeded.organizationId, userId: seeded.userId,
          trigger: queueTrigger, graph, status: 'DRAFT',
        },
        select: { id: true },
      })
      const bindings = await queueBindings()
      assert.ok(
        !bindings.some((entry) => entry.flowId === draft.id),
        'a draft flow was eating live broker messages',
      )
      await prisma.flow.deleteMany({ where: { id: draft.id, organizationId: seeded.organizationId } })
    })

    await t.test('an incomplete configuration is skipped rather than half-connected', async () => {
      const broken = await prisma.flow.create({
        data: {
          name: 'No topic', organizationId: seeded.organizationId, userId: seeded.userId,
          trigger: { type: 'queue', broker: 'amqp', url: 'amqp://broker/' },
          graph, publishedGraph: graph, status: 'ACTIVE',
        },
        select: { id: true },
      })
      const bindings = await queueBindings()
      assert.ok(!bindings.some((entry) => entry.flowId === broken.id))
      await prisma.flow.deleteMany({ where: { id: broken.id, organizationId: seeded.organizationId } })
    })

    await t.test('an unknown broker is not connected to', async () => {
      const odd = await prisma.flow.create({
        data: {
          name: 'Mystery broker', organizationId: seeded.organizationId, userId: seeded.userId,
          trigger: { type: 'queue', broker: 'carrier-pigeon', url: 'x://y', topic: 't' },
          graph, publishedGraph: graph, status: 'ACTIVE',
        },
        select: { id: true },
      })
      const bindings = await queueBindings()
      assert.ok(!bindings.some((entry) => entry.flowId === odd.id))
      await prisma.flow.deleteMany({ where: { id: odd.id, organizationId: seeded.organizationId } })
    })

    await t.test('a non-queue flow produces no binding', async () => {
      const manual = await prisma.flow.create({
        data: {
          name: 'Manual', organizationId: seeded.organizationId, userId: seeded.userId,
          trigger: { type: 'manual' }, graph, publishedGraph: graph, status: 'ACTIVE',
        },
        select: { id: true },
      })
      const bindings = await queueBindings()
      assert.ok(!bindings.some((entry) => entry.flowId === manual.id))
      await prisma.flow.deleteMany({ where: { id: manual.id, organizationId: seeded.organizationId } })
    })
  })
}
