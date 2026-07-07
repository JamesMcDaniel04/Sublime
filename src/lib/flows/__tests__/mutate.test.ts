import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertAgentAfter, insertNodeAfter, appendToBranch, duplicateNode, deleteNode, updateNode } from '../mutate'
import { emptyGraph, type FlowGraph } from '../graph'

test('insertAgentAfter appends a node and links the trigger to it', () => {
  const { graph, nodeId } = insertAgentAfter(emptyGraph(), 'trigger', 'a1')
  assert.equal(graph.nodes.length, 2)
  assert.ok(graph.edges.some((e) => e.source === 'trigger' && e.target === nodeId))
})

test('insertAgentAfter splices between an existing pair, healing the chain', () => {
  // trigger -> n1 ; insert after trigger => trigger -> new -> n1
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const { graph, nodeId } = insertAgentAfter(base, 'trigger', 'a2')
  assert.ok(graph.edges.some((e) => e.source === 'trigger' && e.target === nodeId))
  assert.ok(graph.edges.some((e) => e.source === nodeId && e.target === 'n2')) // new -> old n1 (id n2)
})

test('deleteNode heals predecessor→successor and drops the node', () => {
  let g: FlowGraph = emptyGraph()
  g = insertAgentAfter(g, 'trigger', 'a1').graph // trigger -> n2
  const second = insertAgentAfter(g, g.nodes[1].id, 'a2') // n2 -> n3
  g = second.graph
  g = deleteNode(g, g.nodes[1].id) // delete the middle agent
  assert.equal(g.nodes.length, 2)
  assert.ok(g.edges.some((e) => e.source === 'trigger' && e.target === second.nodeId))
})

test('insertNodeAfter creates typed steps (http, tool, stop)', () => {
  const a = insertNodeAfter(emptyGraph(), 'trigger', 'http')
  const httpNode = a.graph.nodes.find((n) => n.id === a.nodeId)
  assert.equal(httpNode?.type, 'http')
  const b = insertNodeAfter(a.graph, a.nodeId, 'tool')
  assert.equal(b.graph.nodes.find((n) => n.id === b.nodeId)?.type, 'tool')
})

test('appendToBranch wires the first node of an empty false branch', () => {
  let g = insertNodeAfter(emptyGraph(), 'trigger', 'condition').graph
  const condId = g.nodes.find((n) => n.type === 'condition')!.id
  const res = appendToBranch(g, condId, 'false', 'agent', 'a1')
  g = res.graph
  const edge = g.edges.find((e) => e.source === condId && e.branch === 'false')
  assert.equal(edge?.target, res.nodeId)
  // appending again goes to the tail, not a second branch head
  const res2 = appendToBranch(g, condId, 'false', 'stop')
  assert.ok(res2.graph.edges.some((e) => e.source === res.nodeId && e.target === res2.nodeId))
})

test('deleteNode preserves the branch flag when healing a branch head', () => {
  let g = insertNodeAfter(emptyGraph(), 'trigger', 'condition').graph
  const condId = g.nodes.find((n) => n.type === 'condition')!.id
  const first = appendToBranch(g, condId, 'true', 'agent', 'a1')
  g = first.graph
  const second = appendToBranch(g, condId, 'true', 'agent', 'a2')
  g = second.graph
  g = deleteNode(g, first.nodeId) // delete the branch head
  const healed = g.edges.find((e) => e.source === condId && e.branch === 'true')
  assert.equal(healed?.target, second.nodeId)
})

test('duplicateNode copies a step right after the original', () => {
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const orig = base.nodes.find((n) => n.type === 'agent')!
  const { graph, nodeId } = duplicateNode(base, orig.id)
  const copy = graph.nodes.find((n) => n.id === nodeId)
  assert.equal(copy?.type, 'agent')
  assert.ok(graph.edges.some((e) => e.source === orig.id && e.target === nodeId))
})

test('updateNode replaces the matching node', () => {
  const base = insertAgentAfter(emptyGraph(), 'trigger', 'a1').graph
  const target = base.nodes[1]
  const updated = updateNode(base, { ...target, data: { agentId: 'CHANGED', input: 'x' } } as typeof target)
  const found = updated.nodes.find((n) => n.id === target.id)
  assert.equal(found?.type === 'agent' ? found.data.agentId : '', 'CHANGED')
})
