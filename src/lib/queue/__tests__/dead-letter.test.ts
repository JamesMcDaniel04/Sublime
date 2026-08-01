/**
 * Dead-letter capture, driven against the QA Postgres.
 *
 * deadLetterFromJob / deadLetterFromFlowJob write DIFFERENT tables
 * (agent_executions vs flow_runs) and DIFFERENT DLQ queues — both directions
 * are asserted. Redis is never contacted: the memoized producer connection's
 * connect() is a no-op and the DLQ Queue singletons returned by getQueue()
 * have their add() stubbed to capture payloads. captureError is observed via
 * the setErrorReporter seam — it is the last step of both record functions,
 * which also lets the fire-and-forget from-job handlers be awaited.
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
  process.env.REDIS_URL = 'redis://127.0.0.1:6398'
  delete process.env.BULLMQ_DISABLE

  let systemPrisma: any
  let orgA: any
  let orgB: any
  let producerConn: any
  let resetErrorReporter: (() => void) | undefined
  let dl: typeof import('@/lib/queue/dead-letter')
  let fdl: typeof import('@/lib/queue/flow-dead-letter')

  const agentAdds: { name: string; data: any; opts: any }[] = []
  const flowAdds: { name: string; data: any; opts: any }[] = []
  const captures: { error: unknown; context: any }[] = []
  let waiters: ((c: { error: unknown; context: any }) => void)[] = []
  /** recordDeadLetter/recordFlowDeadLetter end with captureError — awaiting the
   *  matching capture is how the `void`-dispatched from-job handlers settle. */
  const nextCapture = (match: (c: { error: unknown; context: any }) => boolean) =>
    new Promise<{ error: unknown; context: any }>((resolve) => {
      const listener = (c: { error: unknown; context: any }) => {
        if (match(c)) resolve(c)
        else waiters.push(listener) // unmatched capture (e.g. redis noise): keep waiting
      }
      waiters.push(listener)
    })

  async function seedExecution(seeded: any, status = 'running') {
    return systemPrisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        status,
        input: {},
        trigger: { type: 'test' },
        userId: seeded.userId,
        organizationId: seeded.organizationId,
      },
    })
  }

  let flowId: string
  async function seedFlowRun(seeded: any, status = 'running') {
    return systemPrisma.flowRun.create({
      data: { flowId, status, organizationId: seeded.organizationId },
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
    producerConn = cfg.getProducerConnection()
    producerConn.connect = async () => {}
    producerConn.options.skipVersionCheck = true
    producerConn.sendCommand = async () => null

    const agentDlq: any = cfg.getQueue(cfg.QUEUE_NAMES.DEAD_LETTER)
    agentDlq.add = async (name: string, data: any, opts: any) => {
      agentAdds.push({ name, data, opts })
    }
    const flowDlq: any = cfg.getQueue(cfg.QUEUE_NAMES.FLOW_DEAD_LETTER)
    flowDlq.add = async (name: string, data: any, opts: any) => {
      flowAdds.push({ name, data, opts })
    }

    ;({ systemPrisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    orgA = await seedTestOrg(systemPrisma)
    orgB = await seedTestOrg(systemPrisma)
    const flow = await systemPrisma.flow.create({
      data: { name: 'dead-letter test flow', organizationId: orgA.organizationId, userId: orgA.userId },
    })
    flowId = flow.id

    dl = await import('@/lib/queue/dead-letter')
    fdl = await import('@/lib/queue/flow-dead-letter')
  })

  after(async () => {
    if (orgA) await orgA.cleanup()
    if (orgB) await orgB.cleanup()
    resetErrorReporter?.()
    producerConn?.disconnect()
  })

  test('recordDeadLetter marks the execution failed, truncates the error to 300 chars, and enqueues the agent DLQ', async () => {
    const execution = await seedExecution(orgA)
    const foreign = await seedExecution(orgB) // same status, other org
    const longError = 'boom '.repeat(100).trim() // > 300 chars

    await dl.recordDeadLetter({
      queue: 'agent-execution',
      jobId: 'job-1',
      executionId: execution.id,
      organizationId: orgA.organizationId,
      data: { hello: 'world' },
      error: longError,
    })

    const row = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id } })
    assert.equal(row.status, 'failed')
    assert.equal(row.error, longError.slice(0, 300))
    assert.equal(row.error.length, 300)
    assert.ok(row.completedAt instanceof Date)

    // Org scoping: the id-keyed write touched no other org's rows.
    const other = await systemPrisma.agentExecution.findUnique({ where: { id: foreign.id } })
    assert.equal(other.status, 'running')

    assert.equal(agentAdds.length, 1)
    assert.equal(agentAdds[0].name, 'dead-letter')
    assert.equal(agentAdds[0].data.executionId, execution.id)
    assert.equal(agentAdds[0].data.organizationId, orgA.organizationId)
    // Dead letters are pinned in the queue for operator inspection.
    assert.deepEqual(agentAdds[0].opts, { removeOnComplete: false, removeOnFail: false })
    // The flow DLQ is a different queue and was not touched.
    assert.equal(flowAdds.length, 0)

    const capture = captures.at(-1)
    assert.deepEqual(capture?.context, {
      queue: 'agent-execution',
      jobId: 'job-1',
      executionId: execution.id,
      organizationId: orgA.organizationId,
    })
  })

  test('recordDeadLetter without an executionId still records the dead letter', async () => {
    await dl.recordDeadLetter({ queue: 'agent-execution', data: {}, error: 'no execution' })
    assert.equal(agentAdds.at(-1)?.data.error, 'no execution')
  })

  test('recordDeadLetter swallows a nonexistent executionId (best-effort DB mark) and still enqueues', async () => {
    await dl.recordDeadLetter({
      queue: 'agent-execution',
      executionId: 'does-not-exist',
      data: {},
      error: 'orphan',
    })
    assert.equal(agentAdds.at(-1)?.data.error, 'orphan')
  })

  test('KNOWN GAP: recordDeadLetter is not status-guarded — it clobbers an already-completed execution to failed', async () => {
    // Documents current behavior: unlike the flow writer (updateMany gated on
    // status: 'running'), the agent writer is a bare id-keyed update. Do not
    // "fix" this test without adding the status guard to recordDeadLetter.
    const execution = await seedExecution(orgA, 'completed')
    await dl.recordDeadLetter({ queue: 'agent-execution', executionId: execution.id, data: {}, error: 'late failure' })
    const row = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id } })
    assert.equal(row.status, 'failed')
  })

  test('deadLetterFromJob extracts string ids from job data and defaults a blank error message', async () => {
    const execution = await seedExecution(orgA)
    const handler = dl.deadLetterFromJob('scheduled-agent-execution')
    const captured = nextCapture((c) => c.context?.queue === 'scheduled-agent-execution')
    handler(
      { id: 'job-2', data: { executionId: execution.id, organizationId: 12345 } } as never,
      new Error(''),
    )
    const capture = await captured
    // Non-string organizationId is dropped rather than persisted as garbage.
    assert.equal(capture.context.organizationId, undefined)
    assert.equal(capture.context.executionId, execution.id)
    const row = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id } })
    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'unknown error')
  })

  test('deadLetterFromJob ignores a missing job entirely', async () => {
    const beforeCount = agentAdds.length
    dl.deadLetterFromJob('agent-execution')(undefined, new Error('nope'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(agentAdds.length, beforeCount)
  })

  test('recordFlowDeadLetter marks the running flow run failed and enqueues the FLOW DLQ, not the agent one', async () => {
    const run = await seedFlowRun(orgA)
    const agentAddsBefore = agentAdds.length
    const longError = 'flow '.repeat(100).trim()

    await fdl.recordFlowDeadLetter({
      queue: 'flow-execution',
      jobId: 'job-3',
      flowRunId: run.id,
      organizationId: orgA.organizationId,
      data: { queuedRunId: run.id },
      error: longError,
    })

    const row = await systemPrisma.flowRun.findUnique({ where: { id: run.id } })
    assert.equal(row.status, 'failed')
    assert.equal(row.error, longError.slice(0, 300))
    assert.ok(row.finishedAt instanceof Date)

    assert.equal(flowAdds.length, 1)
    assert.equal(flowAdds[0].name, 'dead-letter')
    assert.equal(flowAdds[0].data.flowRunId, run.id)
    assert.deepEqual(flowAdds[0].opts, { removeOnComplete: false, removeOnFail: false })
    assert.equal(agentAdds.length, agentAddsBefore)

    assert.deepEqual(captures.at(-1)?.context, {
      queue: 'flow-execution',
      jobId: 'job-3',
      flowRunId: run.id,
      organizationId: orgA.organizationId,
    })
  })

  test('recordFlowDeadLetter is status-guarded: a non-running run is never clobbered', async () => {
    for (const status of ['waiting', 'succeeded']) {
      const run = await seedFlowRun(orgA, status)
      await fdl.recordFlowDeadLetter({ queue: 'flow-execution', flowRunId: run.id, data: {}, error: 'late' })
      const row = await systemPrisma.flowRun.findUnique({ where: { id: run.id } })
      assert.equal(row.status, status)
      assert.equal(row.error, null)
    }
  })

  test('deadLetterFromFlowJob prefers flowRunId over queuedRunId', async () => {
    const preferred = await seedFlowRun(orgA)
    const queued = await seedFlowRun(orgA)
    const handler = fdl.deadLetterFromFlowJob('flow-execution')
    const captured = nextCapture((c) => c.context?.flowRunId === preferred.id)
    handler(
      { id: 'job-4', data: { flowRunId: preferred.id, queuedRunId: queued.id, organizationId: orgA.organizationId } } as never,
      new Error('resume died'),
    )
    await captured
    assert.equal((await systemPrisma.flowRun.findUnique({ where: { id: preferred.id } })).status, 'failed')
    assert.equal((await systemPrisma.flowRun.findUnique({ where: { id: queued.id } })).status, 'running')
  })

  test('deadLetterFromFlowJob falls back to queuedRunId for fresh queued jobs', async () => {
    const run = await seedFlowRun(orgA)
    const handler = fdl.deadLetterFromFlowJob('flow-execution')
    const captured = nextCapture((c) => c.context?.flowRunId === run.id)
    handler({ id: 'job-5', data: { queuedRunId: run.id } } as never, new Error('queued died'))
    await captured
    assert.equal((await systemPrisma.flowRun.findUnique({ where: { id: run.id } })).status, 'failed')
  })
}
