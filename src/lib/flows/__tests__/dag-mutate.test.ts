import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addConnectedNodeAt, addNodeAt, connectNodes, deleteNode, disconnectEdge, moveNodeTo, wouldCreateCycle } from '../mutate'
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

test('addNodeAt drops a standalone node at a position with NO edges (the user wires it)', () => {
  const before = base()
  const { graph, nodeId } = addNodeAt(before, 'http', { x: 40.6, y: 80.2 })
  assert.equal(graph.nodes.length, before.nodes.length + 1)
  assert.deepEqual(graph.layout?.[nodeId], { x: 41, y: 80 })
  assert.equal(
    graph.edges.length,
    before.edges.length,
    'no edges are invented — free-form wiring is the point (contrast insertNodeAfter)',
  )
  assert.ok(graph.nodes.some((n) => n.id === nodeId && n.type === 'http'))
})

test('addNodeAt preserves existing layout entries', () => {
  const { graph } = addNodeAt({ ...base(), layout: { a: { x: 5, y: 6 } } }, 'agent', { x: 0, y: 0 }, 'agt_1')
  assert.deepEqual(graph.layout?.a, { x: 5, y: 6 })
})

test('moveNodeTo records a rounded position without touching other layout', () => {
  const graph = moveNodeTo({ ...base(), layout: { a: { x: 1, y: 2 } } }, 'b', { x: 10.4, y: 20.6 })
  assert.deepEqual(graph.layout?.b, { x: 10, y: 21 })
  assert.deepEqual(graph.layout?.a, { x: 1, y: 2 }, 'other positions are preserved')
})

test('addConnectedNodeAt drops a node at a position AND wires it from the source', () => {
  const before = base()
  const { graph, nodeId } = addConnectedNodeAt(before, 'b', 'http', { x: 400.4, y: 120.6 })
  assert.equal(graph.nodes.length, before.nodes.length + 1)
  assert.deepEqual(graph.layout?.[nodeId], { x: 400, y: 121 })
  assert.ok(
    graph.edges.some((e) => e.source === 'b' && e.target === nodeId && !e.branch),
    'the quick-added step arrives already wired from its source (contrast addNodeAt)',
  )
})

test('addConnectedNodeAt keeps existing outgoing wires — quick-add fans OUT, never splices', () => {
  const before = base() // a→b already exists
  const { graph, nodeId } = addConnectedNodeAt(before, 'a', 'agent', { x: 0, y: 0 }, 'agt_1')
  assert.ok(graph.edges.some((e) => e.source === 'a' && e.target === 'b'), 'the old wire survives')
  assert.ok(graph.edges.some((e) => e.source === 'a' && e.target === nodeId), 'the new wire sits beside it')
})

test('addConnectedNodeAt on a container type still seeds a runnable body step', () => {
  const { graph, nodeId } = addConnectedNodeAt(base(), 'b', 'loop', { x: 0, y: 0 })
  const loop = graph.nodes.find((n) => n.id === nodeId)
  assert.equal(loop?.type, 'loop')
  assert.equal(loop?.type === 'loop' ? loop.data.body.length : 0, 1, 'containers are born runnable')
})

test('addConnectedNodeAt with a vanished source adds the node unwired instead of throwing', () => {
  // A Jam peer can delete the source between the gesture and the pick.
  const before = base()
  const { graph, nodeId } = addConnectedNodeAt(before, 'ghost', 'http', { x: 10, y: 10 })
  assert.ok(graph.nodes.some((n) => n.id === nodeId), 'the node is still added')
  assert.equal(graph.edges.length, before.edges.length, 'no edge to a node that no longer exists')
})

test('addConnectedNodeAt can wire from a specific branch output of an If/else', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { match: 'all', clauses: [{ left: 'x', op: 'contains', right: 'y' }] } },
    ],
    edges: [{ id: 't->cond', source: 'trigger', target: 'cond' }],
  }
  const { graph: next, nodeId } = addConnectedNodeAt(graph, 'cond', 'agent', { x: 0, y: 0 }, 'a1', 'true')
  assert.ok(
    next.edges.some((e) => e.source === 'cond' && e.target === nodeId && e.branch === 'true'),
    'the wire carries the chosen output label — a plain edge from an If/else with both outputs wired would never run',
  )
})

test('deleteNode heals EVERY fan-in path into EVERY successor, not just the first', () => {
  // p1→m, p2→m (fan-in), m→c1, m→c2 (fan-out): deleting m must keep all four paths alive.
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('p1'), agent('p2'), agent('m'), agent('c1'), agent('c2')],
    edges: [
      { id: 't->p1', source: 'trigger', target: 'p1' },
      { id: 't->p2', source: 'trigger', target: 'p2' },
      { id: 'p1->m', source: 'p1', target: 'm' },
      { id: 'p2->m', source: 'p2', target: 'm' },
      { id: 'm->c1', source: 'm', target: 'c1' },
      { id: 'm->c2', source: 'm', target: 'c2' },
    ],
  }
  const healed = deleteNode(graph, 'm')
  for (const parent of ['p1', 'p2']) {
    for (const child of ['c1', 'c2']) {
      assert.ok(
        healed.edges.some((e) => e.source === parent && e.target === child),
        `${parent}→${child} is healed — no silently dropped branch of the diamond`,
      )
    }
  }
})

test('deleteNode healing never duplicates a wire that already exists', () => {
  // p→m→c plus a direct p→c shortcut: healing must not add a second p→c.
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: {} }, agent('p'), agent('m'), agent('c')],
    edges: [
      { id: 't->p', source: 'trigger', target: 'p' },
      { id: 'p->m', source: 'p', target: 'm' },
      { id: 'm->c', source: 'm', target: 'c' },
      { id: 'p->c', source: 'p', target: 'c' },
    ],
  }
  const healed = deleteNode(graph, 'm')
  assert.equal(healed.edges.filter((e) => e.source === 'p' && e.target === 'c').length, 1)
})
