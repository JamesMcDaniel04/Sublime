import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, containedNodeIds, NODE_HEIGHT } from '../auto-layout'
import type { FlowGraph } from '../graph'

const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: id } })

test('empty graph yields an empty layout', () => {
  assert.deepEqual(autoLayout({ nodes: [], edges: [] }), {})
})

test('a linear chain reads LEFT-TO-RIGHT (n8n style)', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a'), agent('b')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }
  const layout = autoLayout(graph)
  assert.equal(Object.keys(layout).length, 3)
  assert.ok(layout.a.x > layout.trigger.x, 'a sits to the RIGHT of the trigger')
  assert.ok(layout.b.x > layout.a.x, 'b sits to the right of a')
  assert.equal(layout.trigger.y, layout.a.y, 'a straight chain stays on one horizontal line')
})

test('fan-out stacks siblings vertically within the same column', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('top'), agent('bottom')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'top' },
      { id: 'e1', source: 'trigger', target: 'bottom' },
    ],
  }
  const layout = autoLayout(graph)
  assert.equal(layout.top.x, layout.bottom.x, 'siblings share a column (rank)')
  assert.ok(Math.abs(layout.top.y - layout.bottom.y) >= NODE_HEIGHT, 'siblings do not overlap')
})

test('fan-in: several sources converge rightward onto one node', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      agent('api1'), agent('api2'), agent('join'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'api1' },
      { id: 'e1', source: 'trigger', target: 'api2' },
      { id: 'e2', source: 'api1', target: 'join' },
      { id: 'e3', source: 'api2', target: 'join' },
    ],
  }
  const layout = autoLayout(graph)
  assert.equal(layout.api1.x, layout.api2.x, 'the two sources share a column')
  assert.ok(layout.join.x > layout.api1.x, 'the join sits to their right')
})

test('a user-placed position is never overwritten', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a')],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
    layout: { a: { x: 999, y: 777 } },
  }
  const layout = autoLayout(graph)
  assert.deepEqual(layout.a, { x: 999, y: 777 })
  assert.ok(layout.trigger, 'the unpositioned node still gets computed coordinates')
})

test('container-body nodes are excluded from the top-level layout', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inner'] } },
      agent('inner'),
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  assert.deepEqual([...containedNodeIds(graph)], ['inner'])
  const layout = autoLayout(graph)
  assert.ok(layout.loop, 'the container is laid out')
  assert.equal(layout.inner, undefined, 'its body node is not — the container renders it')
})

test('parallel branch nodes are excluded too', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'par', type: 'parallel', data: { branches: [['x'], ['y']] } },
      agent('x'), agent('y'),
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'par' }],
  }
  const layout = autoLayout(graph)
  assert.ok(layout.par)
  assert.equal(layout.x, undefined)
  assert.equal(layout.y, undefined)
})
