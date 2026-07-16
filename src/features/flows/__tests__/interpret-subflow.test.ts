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

// Pausable subflows: a child flow that pauses (ask-user / humanReview /
// durable Wait) pauses the PARENT on the subflow node. The adapter returns a
// `waiting` result carrying the child's question or wake time; the
// interpreter parks the run on that node so a resume can re-enter it and
// forward the reply into the child.

test('child flow that pauses parks the parent on the subflow node', async () => {
  const runFlow: RunFlowFn = async () => ({ waiting: { question: 'Which region?' } })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'sub')
  assert.equal(result.waiting?.question, 'Which region?')
})

test('a time-paused child parks the parent with the wake time', async () => {
  const wakeAt = new Date(Date.now() + 3_600_000).toISOString()
  const runFlow: RunFlowFn = async () => ({ waiting: { wakeAt } })
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: echo, runFlow })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.wakeAt, wakeAt)
})

test('resuming re-enters the paused subflow node and continues with its output', async () => {
  const calls: Array<{ resume?: boolean }> = []
  const runFlow: RunFlowFn = async (node) => {
    calls.push({ resume: node.resume })
    // On resume the adapter forwards the reply into the child and returns its
    // final output; a fresh invocation would pause.
    return node.resume ? { output: { answer: 'east' } } : { waiting: { question: 'Which region?' } }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sub', type: 'subflow', data: { flowId: 'c' } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'got {{step.sub.output.answer}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'sub' }, { id: 'e1', source: 'sub', target: 'a' }],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: echo,
    runFlow,
    resumeNodeId: 'sub',
    resumeKey: 'sub',
    resumeReply: 'east',
  })
  assert.deepEqual(calls, [{ resume: true }])
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'got east')
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
