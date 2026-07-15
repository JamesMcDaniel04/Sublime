import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, containedNodeIds, NODE_WIDTH } from '../auto-layout'
import type { FlowGraph } from '../graph'

const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: id } })

test('empty graph yields an empty layout', () => {
  assert.deepEqual(autoLayout({ nodes: [], edges: [] }), {})
})

test('a linear chain lays out top-to-bottom', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a'), agent('b')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
    ],
  }
  const layout = autoLayout(graph)
  assert.equal(Object.keys(layout).length, 3)
  assert.ok(layout.a.y > layout.trigger.y, 'a sits below the trigger')
  assert.ok(layout.b.y > layout.a.y, 'b sits below a')
})

test('fan-out places siblings side by side, not stacked', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('left'), agent('right')],
    edges: [
      { id: 'e0', source: 'trigger', target: 'left' },
      { id: 'e1', source: 'trigger', target: 'right' },
    ],
  }
  const layout = autoLayout(graph)
  assert.equal(layout.left.y, layout.right.y, 'siblings share a rank')
  assert.ok(Math.abs(layout.left.x - layout.right.x) >= NODE_WIDTH, 'siblings do not overlap')
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
