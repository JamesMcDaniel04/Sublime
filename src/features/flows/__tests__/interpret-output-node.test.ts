import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const stub = (map: Record<string, unknown>): RunAgentFn => async (node) => ({ output: map[node.agentId] ?? node.input })

test('output node returns an explicit typed object instead of lastOutput', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'score', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }], input: 'x' } },
      { id: 'out', type: 'output', data: { fields: [
        { name: 'score', type: 'number', value: '{{step.a.output.score}}' },
        { name: 'label', type: 'string', value: 'done' },
      ] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }, { id: 'e1', source: 'a', target: 'out' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ score: '{"score":91}' }) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, { score: 91, label: 'done' })
})

test('BACK-COMPAT: a flow with no output node returns lastOutput', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'hi', { runAgent: stub({}) })
  assert.equal(result.output, 'hi')
})

test('output node coercion error fails the run', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'out', type: 'output', data: { fields: [{ name: 'n', type: 'number', value: 'not-a-number' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'out' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /Output "n"/)
})
