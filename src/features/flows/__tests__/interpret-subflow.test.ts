import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunFlowFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

test('subflow node maps input, blocks on child output, and binds it back', async () => {
  const calls: { flowId: string; input: unknown }[] = []
  const runFlow: RunFlowFn = async (node) => {
    calls.push({ flowId: node.flowId, input: node.input })
    return { output: { score: 91 } }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'flw_child', input: '{"account":"{{trigger.input}}"}' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'score={{step.sub.output.score}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: echo, runFlow })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls, [{ flowId: 'flw_child', input: { account: 'Acme' } }])
  assert.equal(result.output, 'score=91')
})

test('subflow error respects onError=continue', async () => {
  const runFlow: RunFlowFn = async () => ({ error: 'child failed' })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c', onError: 'continue' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'after')
})

test('nested subflow-per-item: one child call per loop item', async () => {
  const seen: unknown[] = []
  const runFlow: RunFlowFn = async (node) => { seen.push(node.input); return { output: node.input } }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '["a","b"]', body: ['sub'] } },
      { id: 'sub', type: 'subflow', data: { flowId: 'c', input: '{"item":"{{item}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.deepEqual(seen, [{ item: 'a' }, { item: 'b' }])
  assert.deepEqual(result.output, [{ item: 'a' }, { item: 'b' }])
})

test('subflow without a runFlow adapter fails cleanly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo })
  assert.equal(result.status, 'failed')
})

// v1 design: subflows are synchronous-only. A child flow that would itself
// pause (its own humanReview/ask-user node) is never forwarded to
// the parent as a pause — the execute-flow.ts `runFlow` adapter translates a
// child `waiting` result into this plain error message before it ever
// reaches interpretFlow (see execute-flow.ts's runFlow adapter). These tests
// exercise the interpreter's handling of that already-translated error: a
// clean fail (respecting onError), and — critically — the run status must be
// `failed`, never `waiting`, so the parent is never left pausable on a
// subflow and no reply can ever be misdirected into an orphaned child run.
const CHILD_PAUSED_MESSAGE =
  "A subflow's child flow paused for human input, which subflows don't support — inline the interaction, or call the flow as an agent tool instead."

test('child flow that would pause is a clean subflow failure, never a parent pause', async () => {
  const runFlow: RunFlowFn = async () => ({ error: CHILD_PAUSED_MESSAGE })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'failed')
  assert.notEqual(result.status, 'waiting')
  assert.equal(result.error, CHILD_PAUSED_MESSAGE)
})

test('child flow that would pause continues past the subflow under onError=continue', async () => {
  const runFlow: RunFlowFn = async () => ({ error: CHILD_PAUSED_MESSAGE })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c', onError: 'continue' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'after')
})

test('subflow surfaces the child\'s real failure reason, not a generic message', async () => {
  const runFlow: RunFlowFn = async () => ({ error: 'child boom' })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'child boom')
})
