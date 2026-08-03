import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  const emptyGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'ResumeClaim', slug: `resume-claim-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'resume-target', organizationId: org.id, status: 'ACTIVE', graph: emptyGraph, publishedGraph: emptyGraph },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('resuming a run that is not `waiting` throws FLOW_RUN_NOT_WAITING and does not re-run it', async () => {
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'succeeded', graphSnapshot: emptyGraph },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'hi' }),
      (error: any) => error.code === 'FLOW_RUN_NOT_WAITING',
    )
    const after1 = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(after1.status, 'succeeded') // untouched — the claim never fired
  })

  test('resuming a run that IS waiting succeeds and pins execution to graphSnapshot, not the flow\'s current graph', async () => {
    // The run's snapshot routes the trigger to a 'legacy' stop node; the flow's
    // CURRENT (edited-after-pause) graph routes the trigger to a differently
    // named 'current-only' stop node instead. If resume re-derived from
    // flow.graph rather than the snapshot, the persisted step would carry the
    // 'current-only' node id, never 'legacy' — this test observes the actual
    // executed step, not just that the run didn't throw.
    const snapshot = {
      nodes: [...emptyGraph.nodes, { id: 'legacy', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }],
      edges: [{ id: 'e-legacy', source: 'trigger', target: 'legacy' }],
    }
    const currentGraph = {
      nodes: [...emptyGraph.nodes, { id: 'current-only', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }],
      edges: [{ id: 'e-current', source: 'trigger', target: 'current-only' }],
    }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    // Simulate the flow having been republished (with a distinctly-shaped
    // graph) since the run paused.
    await prisma.flow.update({ where: { id: ids.flow, organizationId: ids.org }, data: { graph: currentGraph, publishedGraph: currentGraph } })

    // Capture the stale startedAt before resume so we can verify it was refreshed.
    const before = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.ok(before?.startedAt)
    const staleStartedAt = before.startedAt

    const result = await runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' })
    assert.equal(result.flowRunId, run.id)

    const claimed = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.notEqual(claimed.status, 'waiting')
    // Resume claim must refresh startedAt so reapStuckFlowRuns does not mark
    // the run failed the instant it resumes after a long pause.
    assert.ok(claimed?.startedAt)
    assert.ok(claimed.startedAt > staleStartedAt, 'startedAt must be refreshed on resume')

    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id } })
    assert.ok(steps.some((step) => step.nodeId === 'legacy'), 'the snapshot\'s step node must have actually executed')
    assert.ok(!steps.some((step) => step.nodeId === 'current-only'), 'the flow\'s current-graph-only node must never execute on resume')
  })

  test('a resume claim that fails validation rolls the run back to `waiting`, not stuck `running`', async () => {
    // The snapshot references an agent that no longer exists (deleted while
    // the run waited) — validateFlowGraph rejects it AFTER the atomic claim
    // has already flipped the run to `running`. That claim must be undone so
    // the user's reply stays retryable instead of stranding the run until the
    // reaper terminalizes it.
    const snapshot = {
      nodes: [...emptyGraph.nodes, { id: 'agent1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: 'deleted-agent-id', input: 'hi' } }],
      edges: [{ id: 'e-agent', source: 'trigger', target: 'agent1' }],
    }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'go' }),
      (error: any) => error.code === 'FLOW_VALIDATION_ERROR',
    )
    const after2 = await prisma.flowRun.findUnique({ where: { id: run.id, organizationId: ids.org } })
    assert.equal(after2.status, 'waiting') // claim rolled back — the reply stays retryable
  })

  test('a second concurrent resume of the same run loses cleanly after the first claims it', async () => {
    // The snapshot needs at least one non-trigger step or the winning claimant
    // would reject on graph validation (NO_STEPS) instead of fulfilling.
    const snapshot = { nodes: [...emptyGraph.nodes, { id: 'stop', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'marker' } }], edges: [] }
    const run = await prisma.flowRun.create({
      data: { flowId: ids.flow, organizationId: ids.org, userId: ids.user, status: 'waiting', graphSnapshot: snapshot, input: { prompt: '' } },
    })
    const [first, second] = await Promise.allSettled([
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'a' }),
      runFlowExecution({ flowId: ids.flow, organizationId: ids.org, userId: ids.user, flowRunId: run.id, reply: 'b' }),
    ])
    const outcomes = [first, second]
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'FLOW_RUN_NOT_WAITING')
  })

  test('a humanReview step pauses the run, notifies the owner, and the reply becomes its output on resume', async () => {
    const graph = {
      nodes: [
        ...emptyGraph.nodes,
        { id: 'hr', type: 'humanReview', position: { x: 0, y: 0 }, data: { message: 'What segment should we target?' } },
      ],
      edges: [{ id: 'e-hr', source: 'trigger', target: 'hr' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'request-info', organizationId: ids.org, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const paused = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input: 'go' })
    assert.equal(paused.status, 'waiting')

    // The waiting row is interpreter-persisted with the WS8 'input' shape and,
    // unlike an agent pause, has NO agentExecutionId — the flow reply path
    // (execute route -> runFlowExecution) targets the node via this row alone.
    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const waitingRow = steps.find((step) => step.nodeId === 'hr' && step.status === 'waiting')
    assert.ok(waitingRow, 'the humanReview pause must persist a waiting step row')
    assert.equal(waitingRow.agentExecutionId, null)
    assert.deepEqual(waitingRow.output, { waiting: { kind: 'input', question: 'What segment should we target?' } })

    // No assignee configured -> the run owner is notified.
    const note = await prisma.notification.findFirst({ where: { organizationId: ids.org, type: 'flow.needs_input' } })
    assert.ok(note, 'the pause must create a flow.needs_input notification')
    assert.equal(note.userId, ids.user)
    assert.equal(note.level, 'action')

    const resumed = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, flowRunId: paused.flowRunId, reply: 'Mid-market' })
    assert.equal(resumed.status, 'succeeded')
    assert.equal(resumed.output, 'Mid-market')
    const after3: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const finished = after3.filter((step) => step.nodeId === 'hr').at(-1)
    assert.equal(finished.status, 'succeeded')
    assert.equal(finished.output, 'Mid-market')
    // The original waiting row was resolved by the resume, never left dangling.
    assert.ok(!after3.some((step) => step.status === 'waiting'))
  })

  test('a humanReview INSIDE A LOOP resumes the exact paused iteration (resumeKey wired end-to-end)', async () => {
    // The interpreter's resume guards match on resumeKey (nodeId + iteration
    // path). This test goes through the FULL runFlowExecution path — persist,
    // pause, resume-scan, re-interpret — so it fails if execute-flow ever
    // stops forwarding resumeKey to interpretFlow: the bare-id fallback can
    // never match a loop-body iteration, so iteration 0 would re-ask its own
    // question forever instead of consuming the reply and advancing.
    const graph = {
      nodes: [
        ...emptyGraph.nodes,
        { id: 'loop', type: 'loop', position: { x: 0, y: 0 }, data: { over: '{{trigger.input}}', body: ['hr'] } },
        { id: 'hr', type: 'humanReview', position: { x: 0, y: 0 }, data: { message: 'Approve {{item}}?' } },
      ],
      edges: [{ id: 'e-loop', source: 'trigger', target: 'loop' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'loop-review', organizationId: ids.org, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const paused = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input: ['x', 'y'] })
    assert.equal(paused.status, 'waiting')
    const firstSteps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const firstAsk = firstSteps.find((s) => s.nodeId === 'hr' && s.status === 'waiting')
    assert.equal(firstAsk.output.waiting.question, 'Approve x?')
    assert.equal(firstAsk.iterationPath, '0')

    // The reply must land on iteration 0 (the paused one) and the loop must
    // ADVANCE to iteration 1's question — not re-ask iteration 0's.
    const resumed = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, flowRunId: paused.flowRunId, reply: 'yes to x' })
    assert.equal(resumed.status, 'waiting')
    const steps: any[] = await prisma.flowRunStep.findMany({ where: { flowRunId: paused.flowRunId }, orderBy: { order: 'asc' } })
    const iter0 = steps.filter((s) => s.nodeId === 'hr' && s.iterationPath === '0').at(-1)
    assert.equal(iter0.status, 'succeeded')
    assert.equal(iter0.output, 'yes to x')
    const iter1Ask = steps.find((s) => s.nodeId === 'hr' && s.iterationPath === '1' && s.status === 'waiting')
    assert.ok(iter1Ask, 'iteration 1 must now be the one asking')
    assert.equal(iter1Ask.output.waiting.question, 'Approve y?')
  })

  test('a fresh job with queuedRunId adopts the pre-created row instead of creating a second run', async () => {
    // Queue mode pre-creates the FlowRun in dispatchFlowExecution so callers
    // can poll; the worker's runFlowExecution must adopt that row (fill in
    // input/trigger/snapshot) rather than minting a duplicate.
    const stopGraph = {
      nodes: [...emptyGraph.nodes, { id: 'end', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'done' } }],
      edges: [{ id: 'e-end', source: 'trigger', target: 'end' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'adopt-target', organizationId: ids.org, status: 'ACTIVE', graph: stopGraph, publishedGraph: stopGraph },
    })
    const preCreated = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'running', input: { prompt: 'queued' }, trigger: { type: 'webhook' } },
    })
    const result = await runFlowExecution({
      flowId: flow.id,
      organizationId: ids.org,
      userId: ids.user,
      input: 'queued',
      queuedRunId: preCreated.id,
      trigger: { type: 'webhook' },
    })
    assert.equal(result.flowRunId, preCreated.id, 'must execute against the pre-created row')
    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1, 'no duplicate run row')
    const adopted = runs[0]
    assert.ok(adopted.graphSnapshot, 'adoption must persist the graph snapshot')
    assert.notEqual(adopted.status, 'running')
  })

  test('adopting a queuedRunId that was already settled (e.g. reaper-failed) throws instead of re-running', async () => {
    const stopGraph = {
      nodes: [...emptyGraph.nodes, { id: 'end', type: 'stop', position: { x: 0, y: 0 }, data: { reason: 'done' } }],
      edges: [{ id: 'e-end', source: 'trigger', target: 'end' }],
    }
    const flow = await prisma.flow.create({
      data: { name: 'adopt-settled', organizationId: ids.org, status: 'ACTIVE', graph: stopGraph, publishedGraph: stopGraph },
    })
    const settled = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'failed', input: { prompt: '' } },
    })
    await assert.rejects(
      () => runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, queuedRunId: settled.id }),
      /queued flow run/i,
    )
    const after2 = await prisma.flowRun.findUnique({ where: { id: settled.id, organizationId: ids.org } })
    assert.equal(after2.status, 'failed')
    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: settled.id } })
    assert.equal(steps.length, 0, 'a settled row must not gain executed steps')
  })

  test('a recursive subflow call cannot execute another same-org user\'s private flow', async () => {
    const other = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: ids.org } })
    const graph = {
      nodes: [...emptyGraph.nodes, { id: 'end', type: 'stop', data: { reason: 'private' } }],
      edges: [{ id: 'e-end', source: 'trigger', target: 'end' }],
    }
    const privateFlow = await prisma.flow.create({
      data: {
        name: 'private-child', organizationId: ids.org, userId: other.id,
        visibility: 'private', status: 'ACTIVE', graph, publishedGraph: graph,
      },
    })

    await assert.rejects(
      () => runFlowExecution({
        flowId: privateFlow.id,
        organizationId: ids.org,
        userId: ids.user,
        usePublished: true,
        subflowDepth: 1,
      }),
      /Flow not found/,
    )
    assert.equal(await prisma.flowRun.count({ where: { flowId: privateFlow.id, organizationId: ids.org } }), 0)

    await prisma.flow.update({ where: { id: privateFlow.id }, data: { visibility: 'org_viewer' } })
    const shared = await runFlowExecution({
      flowId: privateFlow.id,
      organizationId: ids.org,
      userId: ids.user,
      usePublished: true,
      subflowDepth: 1,
    })
    assert.equal(shared.status, 'stopped')
  })

}
