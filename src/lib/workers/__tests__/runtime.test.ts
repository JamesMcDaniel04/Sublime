/**
 * WorkerRuntime host-process tests — no Redis is running and none is dialed.
 *
 * The constructor takes no dependencies, so fakes are injected at the seams
 * the product code already exposes: the memoized ioredis singletons from
 * queue/config get instance-level patches (connect/duplicate/sendCommand are
 * inert, so BullMQ Worker construction creates no sockets and its run loop
 * parks on a forever-pending command), the DLQ Queue singletons get stubbed
 * add()s, and captureError is observed via setErrorReporter.
 *
 * What is asserted:
 *  - workerSpecs wiring: each agent queue's onFailed routes to the agent
 *    dead-letter writer (agent_executions + agent DLQ), the flow queue's to
 *    the flow writer (flow_runs + flow DLQ), and activity-backfill's straight
 *    to captureError — proven behaviorally against the QA Postgres, since the
 *    handlers are closures whose identity cannot be compared.
 *  - the /health handler's compound readiness (workers running AND redis
 *    PONG), driven through fastify inject with isRunning/ping stubbed.
 *
 * Inert without TEST_DATABASE_URL, like the other .pg tests.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // Dead port on purpose; nothing may actually connect (connect is stubbed).
  // Set before importing runtime.ts: its `import 'dotenv/config'` will not
  // override an already-set variable.
  process.env.REDIS_URL = 'redis://127.0.0.1:6398'
  delete process.env.BULLMQ_DISABLE

  let systemPrisma: any
  let seeded: any
  let redisConn: any
  let producerConn: any
  const duplicates: any[] = []
  let resetErrorReporter: (() => void) | undefined
  let runtime: any

  const agentAdds: { name: string; data: any }[] = []
  const flowAdds: { name: string; data: any }[] = []
  const captures: { error: unknown; context: any }[] = []
  let waiters: ((c: { error: unknown; context: any }) => void)[] = []
  const nextCapture = (match: (c: { error: unknown; context: any }) => boolean) =>
    new Promise<{ error: unknown; context: any }>((resolve) => {
      const listener = (c: { error: unknown; context: any }) => {
        if (match(c)) resolve(c)
        else waiters.push(listener) // unmatched capture (e.g. redis noise): keep waiting
      }
      waiters.push(listener)
    })

  const QUEUES = {
    agent: 'agent-execution',
    scheduled: 'scheduled-agent-execution',
    flow: 'flow-execution',
    backfill: 'activity-backfill',
  }

  const specFor = (queue: string) => runtime.workerSpecs.find((spec: any) => spec.queue === queue)

  async function seedExecution() {
    return systemPrisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        status: 'running',
        input: {},
        trigger: { type: 'test' },
        userId: seeded.userId,
        organizationId: seeded.organizationId,
      },
    })
  }

  let flowId: string
  async function seedFlowRun() {
    return systemPrisma.flowRun.create({
      data: { flowId, status: 'running', organizationId: seeded.organizationId },
    })
  }

  before(async () => {
    const sentry = await import('@/lib/observability/sentry')
    sentry.setErrorReporter((error, context) => {
      const c = { error, context }
      captures.push(c)
      const pending = waiters
      waiters = []
      for (const w of pending) w(c)
    })
    resetErrorReporter = sentry.resetErrorReporter

    const cfg = await import('@/lib/queue/config')
    const { default: IORedis } = await import('ioredis')

    const neutralize = (conn: any) => {
      conn.connect = async () => {}
      conn.options.skipVersionCheck = true
      // Forever-pending rather than resolved: a resolved stub would let the
      // Worker main loop spin hot on instant nulls; a pending one parks it.
      conn.sendCommand = () => new Promise(() => {})
    }
    redisConn = cfg.getRedisConnection()
    neutralize(redisConn)
    // BullMQ duplicates the worker connection for its blocking client.
    redisConn.duplicate = () => {
      const dup: any = new IORedis({ ...redisConn.options, lazyConnect: true })
      neutralize(dup)
      duplicates.push(dup)
      return dup
    }
    producerConn = cfg.getProducerConnection()
    neutralize(producerConn)

    const agentDlq: any = cfg.getQueue(cfg.QUEUE_NAMES.DEAD_LETTER)
    agentDlq.add = async (name: string, data: any) => {
      agentAdds.push({ name, data })
    }
    const flowDlq: any = cfg.getQueue(cfg.QUEUE_NAMES.FLOW_DEAD_LETTER)
    flowDlq.add = async (name: string, data: any) => {
      flowAdds.push({ name, data })
    }

    ;({ systemPrisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(systemPrisma)
    const flow = await systemPrisma.flow.create({
      data: { name: 'runtime test flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    flowId = flow.id

    const { WorkerRuntime } = await import('@/lib/workers/runtime')
    // start() is deliberately NOT called: it asserts deploy env, boots Sentry
    // and begins schedule reconciliation. Construction alone wires the
    // workers, the failed-handlers and the /health route.
    runtime = new WorkerRuntime()
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
    resetErrorReporter?.()
    // The Worker run loops start stalled-check intervals once their (stubbed)
    // connections report ready — force-close clears them so the child test
    // process can exit. Raced against a deadline so a wedged close cannot
    // hang the suite harder than the leak it cleans up.
    if (runtime) {
      await Promise.race([
        Promise.allSettled(runtime.workers.map((worker: any) => worker.close(true))),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ])
      await runtime.server.close()
    }
    redisConn?.disconnect()
    producerConn?.disconnect()
    for (const dup of duplicates) dup.disconnect()
  })

  test('one worker per queue, in the spec order the health payload reports', () => {
    assert.deepEqual(
      runtime.workerSpecs.map((spec: any) => spec.queue),
      [QUEUES.agent, QUEUES.scheduled, QUEUES.flow, QUEUES.backfill],
    )
    assert.equal(runtime.workers.length, runtime.workerSpecs.length)
    runtime.workers.forEach((worker: any, index: number) => {
      assert.equal(worker.name, runtime.workerSpecs[index].queue)
    })
  })

  for (const queue of [QUEUES.agent, QUEUES.scheduled]) {
    test(`${queue} onFailed routes to the AGENT dead-letter writer (agent_executions + agent DLQ)`, async () => {
      const execution = await seedExecution()
      const flowAddsBefore = flowAdds.length
      const captured = nextCapture((c) => c.context?.executionId === execution.id)
      specFor(queue).onFailed(
        { id: `job-${queue}`, data: { executionId: execution.id, organizationId: seeded.organizationId } },
        new Error(`${queue} exploded`),
      )
      const capture = await captured
      assert.equal(capture.context.queue, queue)

      const row = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id } })
      assert.equal(row.status, 'failed')
      assert.equal(row.error, `${queue} exploded`)
      assert.equal(agentAdds.at(-1)?.data.executionId, execution.id)
      assert.equal(agentAdds.at(-1)?.data.queue, queue)
      assert.equal(flowAdds.length, flowAddsBefore, 'agent failures must not reach the flow DLQ')
    })
  }

  test('flow-execution onFailed routes to the FLOW dead-letter writer (flow_runs + flow DLQ)', async () => {
    const run = await seedFlowRun()
    const agentAddsBefore = agentAdds.length
    const captured = nextCapture((c) => c.context?.flowRunId === run.id)
    specFor(QUEUES.flow).onFailed(
      { id: 'job-flow', data: { flowRunId: run.id, organizationId: seeded.organizationId } },
      new Error('flow exploded'),
    )
    const capture = await captured
    assert.equal(capture.context.queue, QUEUES.flow)

    const row = await systemPrisma.flowRun.findUnique({ where: { id: run.id } })
    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'flow exploded')
    assert.equal(flowAdds.at(-1)?.data.flowRunId, run.id)
    assert.equal(agentAdds.length, agentAddsBefore, 'flow failures must not reach the agent DLQ')
  })

  test('activity-backfill onFailed reports to Sentry only — no dead-letter table or queue', async () => {
    const agentAddsBefore = agentAdds.length
    const flowAddsBefore = flowAdds.length
    const captured = nextCapture((c) => c.context?.source === 'worker.activity-backfill')
    specFor(QUEUES.backfill).onFailed({ id: 'job-backfill' }, new Error('backfill exploded'))
    const capture = await captured
    assert.equal(capture.context.jobId, 'job-backfill')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(agentAdds.length, agentAddsBefore)
    assert.equal(flowAdds.length, flowAddsBefore)
  })

  test('/health is 200 healthy only when every worker runs AND redis answers PONG', async () => {
    runtime.workers.forEach((worker: any) => {
      worker.isRunning = () => true
    })
    redisConn.ping = async () => 'PONG'

    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.status, 'healthy')
    assert.equal(body.redis, true)
    assert.deepEqual(body.workers, {
      [QUEUES.agent]: true,
      [QUEUES.scheduled]: true,
      [QUEUES.flow]: true,
      [QUEUES.backfill]: true,
    })
    assert.equal(typeof body.uptime, 'number')
  })

  test('/health is 503 when redis ping throws, even with all workers running', async () => {
    redisConn.ping = async () => {
      throw new Error('redis down')
    }
    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 503)
    const body = response.json()
    assert.equal(body.status, 'unhealthy')
    assert.equal(body.redis, false)
  })

  test('/health is 503 when redis answers but the ping is not PONG', async () => {
    redisConn.ping = async () => 'LOADING'
    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().redis, false)
  })

  test('/health is 503 when any single worker is not running, and names it', async () => {
    redisConn.ping = async () => 'PONG'
    const scheduledIndex = runtime.workerSpecs.findIndex((spec: any) => spec.queue === QUEUES.scheduled)
    runtime.workers[scheduledIndex].isRunning = () => false

    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 503)
    const body = response.json()
    assert.equal(body.status, 'unhealthy')
    assert.equal(body.redis, true, 'redis stays truthful while a worker is down')
    assert.equal(body.workers[QUEUES.scheduled], false)
    assert.equal(body.workers[QUEUES.agent], true)

    runtime.workers[scheduledIndex].isRunning = () => true
  })

  // ── Graph-RAG on the worker ───────────────────────────────────────────────
  //
  // This process is where production agent runs actually execute, so whether
  // it can reach the graph is exactly what an operator needs to see — the
  // 2026-08-24 gap was invisible precisely because nothing on this process
  // ever said. Report it here.
  test('/health reports the graph-RAG probe alongside redis and the database', async () => {
    runtime.workers.forEach((worker: any) => { worker.isRunning = () => true })
    redisConn.ping = async () => 'PONG'
    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    const body = response.json()
    assert.ok(body.graphRag, `expected a graphRag field, got keys: ${JSON.stringify(Object.keys(body))}`)
    assert.equal(body.graphRag.configured, false, 'no NEO4J_* is set in this test process')
  })

  // The other half, and the one that must not regress: graph-RAG stays OUT of
  // the 503 condition. RAG degrades gracefully by design, so failing readiness
  // over it would have Fly restart-loop a worker that is executing runs fine —
  // trading a degraded feature for a genuine outage. A guard, not a RED test.
  test('/health stays 200 when graph-RAG is unconfigured — it is reported, never gating', async () => {
    runtime.workers.forEach((worker: any) => { worker.isRunning = () => true })
    redisConn.ping = async () => 'PONG'
    const response = await runtime.server.inject({ method: 'GET', url: '/health' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().status, 'healthy')
  })
}
