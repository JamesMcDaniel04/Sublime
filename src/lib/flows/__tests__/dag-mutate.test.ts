import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectNodes, disconnectEdge, moveNodeTo, wouldCreateCycle } from '../mutate'
import type { FlowGraph } from '../graph'

const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: id } })

// trigger → a → b
const base = (): FlowGraph => ({
  nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('a'), agent('b'), agent('c')],
  edges: [
    { id: 'trigger->a', source: 'trigger', target: 'a' },
    { id: 'a->b', source: 'a', target: 'b' },
  ],
})

test('connects two nodes (many→many fan-in is allowed)', () => {
  const res = connectNodes(base(), 'c', 'b')
  assert.ok('graph' in res)
  const edges = (res as { graph: FlowGraph }).graph.edges
  assert.ok(edges.some((e) => e.source === 'c' && e.target === 'b'), 'b now has two parents')
  assert.equal(edges.length, 3)
})

test('refuses a self-connection', () => {
  const res = connectNodes(base(), 'a', 'a')
  assert.ok('error' in res)
  assert.match((res as { error: string }).error, /itself/i)
})

test('refuses a duplicate connection', () => {
  const res = connectNodes(base(), 'a', 'b')
  assert.ok('error' in res)
  assert.match((res as { error: string }).error, /already connected/i)
})

test('refuses a connection that would create a cycle', () => {
  // b → trigger would close trigger → a → b → trigger
  const res = connectNodes(base(), 'b', 'trigger')
  assert.ok('error' in res)
  assert.match((res as { error: string }).error, /loop/i)
})

test('wouldCreateCycle detects direct and transitive loops', () => {
  const graph = base()
  assert.equal(wouldCreateCycle(graph, 'b', 'trigger'), true, 'transitive')
  assert.equal(wouldCreateCycle(graph, 'a', 'a'), true, 'self')
  assert.equal(wouldCreateCycle(graph, 'c', 'b'), false, 'fan-in is not a cycle')
  assert.equal(wouldCreateCycle(graph, 'b', 'c'), false, 'forward is fine')
})

test('a diamond is allowed (re-convergence is not a cycle)', () => {
  // trigger→a→b, plus a→c and c→b  ⇒ diamond a→{b,c}→b
  const step1 = connectNodes(base(), 'a', 'c')
  assert.ok('graph' in step1)
  const step2 = connectNodes((step1 as { graph: FlowGraph }).graph, 'c', 'b')
  assert.ok('graph' in step2, 'diamond wiring is accepted')
})

test('disconnectEdge removes only that wire', () => {
  const graph = disconnectEdge(base(), 'a->b')
  assert.equal(graph.edges.length, 1)
  assert.ok(graph.nodes.some((n) => n.id === 'b'), 'the node stays')
})

test('moveNodeTo records a rounded position without touching other layout', () => {
  const graph = moveNodeTo({ ...base(), layout: { a: { x: 1, y: 2 } } }, 'b', { x: 10.4, y: 20.6 })
  assert.deepEqual(graph.layout?.b, { x: 10, y: 21 })
  assert.deepEqual(graph.layout?.a, { x: 1, y: 2 }, 'other positions are preserved')
})
