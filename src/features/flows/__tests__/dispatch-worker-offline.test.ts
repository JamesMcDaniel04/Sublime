import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Worker-offline hardening: in queue mode, dispatch must not strand a fresh
 * run at `running` (or silently swallow a resume) when no worker heartbeat is
 * live — the exact failure that left flows stuck on "Thinking…" while the
 * queue had no consumer. Forcing queue mode with no REDIS_URL reproduces
 * "offline" with real code: liveness reads as dead because the producer
 * connection cannot even be constructed.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.EXECUTION_MODE = 'queue' // must be set before execute-flow's module-scope read
  delete process.env.REDIS_URL

  let prisma: any
  let dispatchFlowExecution: any
  let reapNeverStartedFlowRuns: any
  let NEVER_STARTED_TIMEOUT_MS: number
  const ids: Record<string, string> = {}

  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ dispatchFlowExecution } = await import('../execute-flow'))
    ;({ reapNeverStartedFlowRuns, NEVER_STARTED_TIMEOUT_MS } = await import('@/lib/flows/reap'))
    // Non-trial plan: dispatch runs the billing gate before anything else, and
    // a bare TRIAL org reads as payment_required.
    const org = await prisma.organization.create({
      data: { name: 'WorkerOffline', slug: `worker-offline-${Date.now()}`, plan: 'PROFESSIONAL' },
    })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'offline-target', organizationId: org.id, status: 'ACTIVE', graph: emptyGraph, publishedGraph: emptyGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('fresh dispatch with no worker heartbeat fails the run immediately instead of stranding it running', async () => {
    const result = await dispatchFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, input: '' })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /offline/i)
    const run = await prisma.flowRun.findUnique({ where: { id: result.flowRunId, organizationId: ids.org } })
    assert.equal(run.status, 'failed')
    assert.match(run.error, /offline/i)
    assert.ok(run.finishedAt)
  })

  test('resume dispatch with no worker heartbeat rejects loudly and leaves the run waiting for a retry', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: emptyGraph },
    })
    await assert.rejects(
      () => dispatchFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' }),
      (error: any) => error.code === 'FLOW_WORKER_OFFLINE',
    )
    const untouched = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(untouched.status, 'waiting') // reply-able again once the worker is back
  })

  test('reapNeverStartedFlowRuns fails only stale zero-step running runs', async () => {
    const staleStart = new Date(Date.now() - NEVER_STARTED_TIMEOUT_MS - 1_000)
    const mk = (data: Record<string, unknown>) =>
      prisma.flowRun.create({ data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, ...data } })

    const staleNoSteps = await mk({ status: 'running', startedAt: staleStart })
    const staleWithStep = await mk({ status: 'running', startedAt: staleStart })
    await prisma.flowRunStep.create({ data: { flowRunId: staleWithStep.id, nodeId: 'trigger', status: 'running', order: 0 } })
    const freshNoSteps = await mk({ status: 'running' })
    const staleWaiting = await mk({ status: 'waiting', startedAt: staleStart })

    const reaped = await reapNeverStartedFlowRuns()
    assert.ok(reaped >= 1)

    const [a, b, c, d] = await Promise.all(
      [staleNoSteps, staleWithStep, freshNoSteps, staleWaiting].map((run) =>
        prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } }),
      ),
    )
    assert.equal(a.status, 'failed')
    assert.match(a.error, /offline|picked up/i)
    assert.equal(b.status, 'running') // has a step — it genuinely started
    assert.equal(c.status, 'running') // too recent to judge
    assert.equal(d.status, 'waiting') // paused runs are not the reaper's business
  })
}
