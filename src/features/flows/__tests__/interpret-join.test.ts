import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

function graph(extra: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: { branches: [['x'], ['y']], ...extra } },
      { id: 'x', type: 'agent', data: { agentId: 'a', input: 'A' } },
      { id: 'y', type: 'agent', data: { agentId: 'a', input: 'B' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'p' }],
  }
}

test('BACK-COMPAT: parallel with no join returns the keyed-by-head-id object', async () => {
  const result = await interpretFlow(graph({}), '', { runAgent: echo })
  assert.deepEqual(result.output, { x: 'A', y: 'B' })
})

test('join array returns outputs in branch order', async () => {
  const result = await interpretFlow(graph({ join: 'array' }), '', { runAgent: echo })
  assert.deepEqual(result.output, ['A', 'B'])
})

test('join object keys by labels', async () => {
  const result = await interpretFlow(graph({ join: 'object', labels: ['left', 'right'] }), '', { runAgent: echo })
  assert.deepEqual(result.output, { left: 'A', right: 'B' })
})
