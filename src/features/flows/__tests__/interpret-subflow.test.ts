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
