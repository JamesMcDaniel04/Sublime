import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import { completedKey } from '../completed-key'
import type { FlowGraph } from '@/lib/flows/graph'

// Bug A: a loop-body node has ONE graph id executed once per iteration, so a
// flat nodeId -> output `completed` map collapses every iteration to the last
// write. These tests exercise interpretFlow directly (no DB) with a hand-built
// `completed` map — the exact shape execute-flow.ts's resume scan now builds
// via completedKey/resolveResumeState.

test('loop body completes iteration 0, pauses iteration 1: resume must resume iteration 1, not replay iteration 0\'s output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: { id: string; resume?: boolean }[] = []
  const runAgent: RunAgentFn = async (node) => {
    calls.push({ id: node.id, resume: node.resume })
    return { output: calls.length === 1 ? 'resumed-out' : 'fresh-out' }
  }
  const completed = { [completedKey('a', [0])]: 'iter0-out' }
  const result = await interpretFlow(graph, ['x', 'y', 'z'], {
    runAgent,
    completed,
    resumeNodeId: 'a',
    // resolveResumeState derives this from the waiting row's iterationPath —
    // it names the EXACT iteration that paused, not just the node id.
    resumeKey: completedKey('a', [1]),
    resumeReply: 'here is my answer',
  })
  // Iteration 0 short-circuits from `completed` — only iterations 1 and 2 call runAgent.
  assert.equal(calls.length, 2)
  assert.equal(calls[0].resume, true)
  // Iteration 2 never paused: it must run FRESH, not re-enter the paused
  // execution (the pre-fix bare-nodeId guard marked it resume:true too).
  assert.equal(calls[1].resume, false)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, ['iter0-out', 'resumed-out', 'fresh-out'])
})

test('FAILS PRE-FIX: today\'s bare-nodeId short-circuit either misses the cached iteration or collapses every iteration to it', async () => {
  // Regression guard mirroring the bug directly: a completed map keyed by the
  // OLD (pre-fix) flat nodeId format applied against a 3-item loop should NOT
  // be trusted for more than one iteration. This test documents the fixed
  // contract: only the exact iteration path named in `completed` short-circuits.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: string[] = []
  const runAgent: RunAgentFn = async () => {
    calls.push('called')
    return { output: 'fresh-out' }
  }
  // A bare-nodeId key (today's pre-fix shape) must NOT short-circuit every
  // iteration under the fixed interpreter — it only matches a step with NO
  // iteration path (i.e. one that never ran inside a loop).
  const completed = { a: 'stale-bare-key-output' }
  const result = await interpretFlow(graph, ['x', 'y', 'z'], { runAgent, completed })
  assert.equal(calls.length, 3)
  assert.deepEqual(result.output, ['fresh-out', 'fresh-out', 'fresh-out'])
})

test('resumed iteration\'s output feeds a downstream step correctly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['a', 'b'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
      { id: 'b', type: 'transform', data: { fields: [{ name: 'value', value: '{{step.a.output}}' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: 'resumed-out' })
  const completed = { [completedKey('a', [0])]: 'iter0-out' }
  const result = await interpretFlow(graph, ['x', 'y'], {
    runAgent,
    completed,
    resumeNodeId: 'a',
    resumeKey: completedKey('a', [1]),
    resumeReply: 'reply',
  })
  assert.equal(result.status, 'succeeded')
  // iteration 0's transform used the cached value; iteration 1's used the
  // freshly-resumed value, not iteration 0's stale cached output.
  assert.deepEqual(result.output, [{ value: 'iter0-out' }, { value: 'resumed-out' }])
})

test('nested loop: iteration path disambiguates outer x inner combos', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'outerLoop', type: 'loop', data: { over: '{{trigger.input}}', body: ['innerLoop'] } },
      { id: 'innerLoop', type: 'loop', data: { over: '{{item}}', body: ['a'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'outerLoop' }],
  }
  const calls: string[] = []
  const runAgent: RunAgentFn = async () => {
    calls.push('called')
    return { output: 'o1i1-fresh' }
  }
  const completed = {
    [completedKey('a', [0, 0])]: 'o0i0',
    [completedKey('a', [0, 1])]: 'o0i1',
    [completedKey('a', [1, 0])]: 'o1i0',
    // deliberately NOT present: [1,1] — that's the pause point
  }
  const input = [
    ['a0', 'a1'],
    ['b0', 'b1'],
  ]
  const result = await interpretFlow(graph, input, { runAgent, completed, resumeNodeId: 'a', resumeKey: completedKey('a', [1, 1]), resumeReply: 'x' })
  // Only the uncached combo (outer=1, inner=1) actually calls runAgent; inner
  // index 0 appears in TWO different (correct) cached outputs (o0i0, o1i0),
  // proving the fix disambiguates by the full path, not a scalar inner index.
  assert.equal(calls.length, 1)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, [
    ['o0i0', 'o0i1'],
    ['o1i0', 'o1i1-fresh'],
  ])
})

// ── Resume-TARGET iteration-scoping (fix #2) ────────────────────────────────
// The first fix made the completed-map READ side iteration-aware but left the
// resume guards keyed by bare node id, so on resume EVERY not-yet-completed
// iteration of the paused node id matched `resume` — a later fresh iteration
// then tried to re-enter the already-settled execution and failed the run.

test('threaded loop paused before its last iteration: the iteration AFTER the paused one runs fresh, not as a resume', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['a'], threadAgent: true } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'Process {{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: { resume?: boolean }[] = []
  const runAgent: RunAgentFn = async (node) => {
    calls.push({ resume: node.resume })
    return { output: node.resume ? 'resumed-out' : 'fresh-out' }
  }
  // Run 1 completed iteration 0, then iteration 1's agent paused (threaded
  // loops break on the pause, so iteration 2 never ran).
  const completed = { [completedKey('a', [0])]: 'iter0-out' }
  const result = await interpretFlow(graph, ['x', 'y', 'z'], {
    runAgent,
    completed,
    resumeNodeId: 'a',
    resumeKey: completedKey('a', [1]),
    resumeReply: 'reply for iteration 1',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls.length, 2)
  // iteration 1 = the paused one: resumes.
  assert.equal(calls[0].resume, true)
  // iteration 2 never paused: MUST run fresh. Pre-fix, the bare-nodeId guard
  // marked it resume:true too, re-entering iteration 1's settled execution
  // (which throws in production) — the exact reviewed defect.
  assert.equal(calls[1].resume, false)
  assert.deepEqual(result.output, ['iter0-out', 'resumed-out', 'fresh-out'])
})

test('humanReview in a loop: the reply is consumed ONLY by the iteration whose key matches, never broadcast', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['review'] } },
      { id: 'review', type: 'humanReview', data: { message: 'Approve {{item}}?' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  // The reply targets iteration 1, but iteration 0 is ALSO still unresolved.
  // Fixed contract: iteration 0 must NOT consume iteration 1's reply — it
  // re-pauses, so the run stays waiting on iteration 0's own question.
  // (Pre-fix, the bare-id match fed the same reply to every unresolved
  // iteration and the loop "succeeded" with the answer cross-wired.)
  const neverCalled: RunAgentFn = async () => {
    throw new Error('no agent in this graph')
  }
  const paused = await interpretFlow(graph, ['x', 'y'], {
    runAgent: neverCalled,
    resumeNodeId: 'review',
    resumeKey: completedKey('review', [1]),
    resumeReply: 'yes — but only for y',
  })
  assert.equal(paused.status, 'waiting')
  assert.match(paused.waiting?.question ?? '', /Approve x\?/)

  // With iteration 0 already settled, the same reply now reaches its true
  // target: iteration 1 consumes it and the loop completes.
  const resumed = await interpretFlow(graph, ['x', 'y'], {
    runAgent: neverCalled,
    completed: { [completedKey('review', [0])]: 'approved-x' },
    resumeNodeId: 'review',
    resumeKey: completedKey('review', [1]),
    resumeReply: 'yes — but only for y',
  })
  assert.equal(resumed.status, 'succeeded')
  assert.deepEqual(resumed.output, ['approved-x', 'yes — but only for y'])
})
