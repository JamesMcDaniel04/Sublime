import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('emptyGraph has a single manual trigger node and no edges', () => {
  const g = emptyGraph()
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].type, 'trigger')
  assert.deepEqual(g.edges, [])
})

test('flowGraphSchema accepts a valid agent+condition graph', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'condition', data: { left: '{{step.n1.output}}', op: 'contains', right: 'yes' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  assert.equal(parsed.nodes.length, 3)
})

test('flowGraphSchema rejects an unknown node type', () => {
  assert.throws(() => flowGraphSchema.parse({ nodes: [{ id: 'x', type: 'webhook', data: {} }], edges: [] }))
})

test('flowGraphSchema rejects a condition with a bad op', () => {
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [{ id: 'c', type: 'condition', data: { left: 'a', op: 'startsWith', right: 'b' } }],
      edges: [],
    }),
  )
})
