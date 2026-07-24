/**
 * Single-node test input resolution: which upstream data feeds the node under
 * test (pin › last run › missing), which missing ancestors are dangerous to
 * materialise, which descendants a "Run from here" would fire, and the
 * dependency order for materialising ancestors. All four graph walks live and
 * are tested together.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { downstreamWriteActions, resolveNodeTestInput, riskForNode, topoSortByGraph, type NodeRef } from '../node-test-input'
import type { FlowGraph, FlowNode } from '../graph'

// trigger → a → b → c
const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'http', data: { method: 'GET', url: 'https://api/a' } },
    { id: 'b', type: 'http', data: { method: 'GET', url: 'https://api/b' } },
    { id: 'c', type: 'http', data: { method: 'POST', url: 'https://api/c' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ],
} as unknown as FlowGraph

test('prefers a pin over the last run output', () => {
  const result = resolveNodeTestInput({
    nodeId: 'b',
    graph,
    pins: { a: { from: 'pin' } },
    lastOutputs: { a: { from: 'run' } },
  })
  assert.deepEqual(result.mockOutputs.a, { from: 'pin' })
  assert.deepEqual(result.missing, [])
})

test('falls back to the last run output when no pin exists', () => {
  const result = resolveNodeTestInput({ nodeId: 'b', graph, pins: {}, lastOutputs: { a: { from: 'run' } } })
  assert.deepEqual(result.mockOutputs.a, { from: 'run' })
  assert.deepEqual(result.missing, [])
})

test('reports ancestors with neither pin nor run output as missing', () => {
  const result = resolveNodeTestInput({ nodeId: 'c', graph, pins: {}, lastOutputs: {} })
  assert.deepEqual(result.missing.map((ref) => ref.id).sort(), ['a', 'b'])
})

test('only ANCESTORS are considered — never downstream nodes', () => {
  // Resolving input for 'b' must not care about 'c'. If it did, a node with an
  // unrun descendant would look unresolvable forever.
  const result = resolveNodeTestInput({ nodeId: 'b', graph, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.some((ref) => ref.id === 'c'), false)
})

test('flags missing ancestors that perform writes', () => {
  const result = resolveNodeTestInput({
    nodeId: 'c',
    graph,
    pins: { a: { ok: true } },
    lastOutputs: {},
    riskOf: (id) => (id === 'b' ? 'destructive' : 'read'),
  })
  assert.deepEqual(result.riskyMissing.map((ref) => ref.id), ['b'])
  // riskyMissing is a SUBSET of missing, never a separate list.
  assert.ok(result.riskyMissing.every((ref) => result.missing.some((entry) => entry.id === ref.id)))
})

test('the trigger is never reported as a missing ancestor', () => {
  // A manual test supplies trigger input directly, so the trigger is never
  // something the user must "run first".
  const result = resolveNodeTestInput({ nodeId: 'a', graph, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.some((ref) => ref.id === 'trigger'), false)
})

const diamond = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'root', type: 'http', data: { method: 'GET', url: 'https://api/root' } },
    { id: 'l', type: 'http', data: { method: 'GET', url: 'https://api/l' } },
    { id: 'r', type: 'http', data: { method: 'GET', url: 'https://api/r' } },
    { id: 'join', type: 'http', data: { method: 'GET', url: 'https://api/j' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'root' },
    { id: 'e1', source: 'root', target: 'l' },
    { id: 'e2', source: 'root', target: 'r' },
    { id: 'e3', source: 'l', target: 'join' },
    { id: 'e4', source: 'r', target: 'join' },
  ],
} as unknown as FlowGraph

test('a diamond ancestor is reported once, not twice', () => {
  const result = resolveNodeTestInput({ nodeId: 'join', graph: diamond, pins: {}, lastOutputs: {} })
  assert.equal(result.missing.filter((ref) => ref.id === 'root').length, 1)
})

// ── riskForNode ───────────────────────────────────────────────────────────────

test('riskForNode reads a tool node persisted risk', () => {
  assert.equal(riskForNode({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'delete_all', risk: 'destructive' } } as FlowNode), 'destructive')
})

test('riskForNode treats a non-GET http node as a write', () => {
  // No persisted risk on http nodes — the method is the only signal, and
  // guessing "read" for a POST is the dangerous direction to be wrong in.
  assert.equal(riskForNode({ id: 'h', type: 'http', data: { method: 'POST', url: 'https://api/x' } } as FlowNode), 'write')
  assert.equal(riskForNode({ id: 'h', type: 'http', data: { method: 'GET', url: 'https://api/x' } } as FlowNode), 'read')
  assert.equal(riskForNode({ id: 'h', type: 'http', data: { method: 'HEAD', url: 'https://api/x' } } as FlowNode), 'read')
})

test('riskForNode defaults an unclassified tool node to write, not read', () => {
  // An older graph may carry no risk field. Defaulting to read would let a
  // real write run without the confirmation this exists to trigger.
  assert.equal(riskForNode({ id: 't', type: 'tool', data: { connectionId: 'c', toolName: 'send' } } as FlowNode), 'write')
})

test('riskForNode calls pure in-memory steps read', () => {
  assert.equal(riskForNode({ id: 'x', type: 'transform', data: { fields: [] } } as unknown as FlowNode), 'read')
  assert.equal(riskForNode({ id: 'x', type: 'condition', data: { clauses: [] } } as unknown as FlowNode), 'read')
})

test('riskForNode treats agent and subflow steps as writes', () => {
  // An agent can call write tools and a subflow can contain anything — neither
  // is safe to fire unannounced just to materialise test data.
  assert.equal(riskForNode({ id: 'g', type: 'agent', data: { agentId: 'a1' } } as FlowNode), 'write')
  assert.equal(riskForNode({ id: 's', type: 'subflow', data: { flowId: 'f1' } } as FlowNode), 'write')
})

// ── downstreamWriteActions ────────────────────────────────────────────────────

test('downstreamWriteActions finds transitive descendants that write', () => {
  const g = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'transform', data: { fields: [] } },
      { id: 'b', type: 'http', data: { method: 'POST', url: 'https://api/b' } },
      { id: 'c', type: 'transform', data: { fields: [] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ],
  } as unknown as FlowGraph
  // From 'a': 'b' writes, 'c' does not, and 'a' itself is never included.
  assert.deepEqual(downstreamWriteActions({ nodeId: 'a', graph: g }).map((ref) => ref.id), ['b'])
  assert.deepEqual(downstreamWriteActions({ nodeId: 'b', graph: g }).map((ref) => ref.id), [])
})

// ── topoSortByGraph ───────────────────────────────────────────────────────────

test('topoSortByGraph puts a shared ancestor before both dependents, once', () => {
  const g = {
    nodes: [
      { id: 'root', type: 'transform', data: { fields: [] } },
      { id: 'l', type: 'transform', data: { fields: [] } },
      { id: 'r', type: 'transform', data: { fields: [] } },
    ],
    edges: [
      { id: 'e0', source: 'root', target: 'l' },
      { id: 'e1', source: 'root', target: 'r' },
    ],
  } as unknown as FlowGraph
  const refs: NodeRef[] = [
    { id: 'l', label: 'L', risk: 'read' },
    { id: 'root', label: 'Root', risk: 'read' },
    { id: 'r', label: 'R', risk: 'read' },
  ]
  const order = topoSortByGraph(refs, g).map((ref) => ref.id)
  assert.equal(order.filter((id) => id === 'root').length, 1)
  assert.ok(order.indexOf('root') < order.indexOf('l'))
  assert.ok(order.indexOf('root') < order.indexOf('r'))
})

test('topoSortByGraph ignores edges to nodes outside the set', () => {
  // Ancestors already satisfied by pins/last-run are not in the refs list —
  // their edges must not deadlock the sort.
  const refs: NodeRef[] = [{ id: 'b', label: 'B', risk: 'read' }]
  assert.deepEqual(topoSortByGraph(refs, graph).map((ref) => ref.id), ['b'])
})
