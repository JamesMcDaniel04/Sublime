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
    resumeReply: 'here is my answer',
  })
  // Iteration 0 short-circuits from `completed` — only iterations 1 and 2 call runAgent.
  assert.equal(calls.length, 2)
  assert.equal(calls[0].resume, true)
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
  const result = await interpretFlow(graph, input, { runAgent, completed, resumeNodeId: 'a', resumeReply: 'x' })
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
