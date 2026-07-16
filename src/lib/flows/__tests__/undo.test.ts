import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyGraph, type FlowGraph } from '../graph'
import { insertNodeAfter, updateNode } from '../mutate'
import { applyFlowCollaborationPatch, diffFlowGraphs } from '../collaboration'
import { applyPatchStrict, invertPatch } from '../undo'

function httpFixture() {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  return { base, http }
}

/** Narrowed lookup so `data` spreads type-check against the http node member. */
function httpNodeIn(graph: FlowGraph, id: string) {
  const node = graph.nodes.find((n) => n.type === 'http' && n.id === id)
  if (!node || node.type !== 'http') throw new Error(`missing http node ${id}`)
  return node
}

function urlOf(graph: FlowGraph, id: string): unknown {
  const node = graph.nodes.find((n) => n.id === id)
  return node?.type === 'http' ? node.data.url : undefined
}

test('undoing your own field edit restores the previous value', () => {
  const { base, http } = httpFixture()
  const edited = updateNode(base, { ...http, data: { ...http.data, url: 'https://mine.test' } })
  const forward = diffFlowGraphs(base, edited, 'op1')

  const undone = applyPatchStrict(edited, invertPatch(forward, 'undo1'))

  assert.equal(urlOf(undone.graph, http.id), urlOf(base, http.id))
  assert.deepEqual(undone.skipped, [])
})

test('undo rebases over a peer edit to a DIFFERENT field — peer work survives', () => {
  const { base, http } = httpFixture()
  const mine = updateNode(base, { ...http, data: { ...http.data, url: 'https://mine.test' } })
  const forward = diffFlowGraphs(base, mine, 'op1')

  // A peer renames the node AFTER my edit landed.
  const mineNode = httpNodeIn(mine, http.id)
  const peer = applyFlowCollaborationPatch(
    mine,
    diffFlowGraphs(mine, updateNode(mine, { ...mineNode, data: { ...mineNode.data, label: 'Peer label' } }), 'peer'),
  ).graph

  const undone = applyPatchStrict(peer, invertPatch(forward, 'undo1'))

  assert.equal(urlOf(undone.graph, http.id), urlOf(base, http.id))
  const node = undone.graph.nodes.find((n) => n.id === http.id)
  assert.equal(node?.type === 'http' ? node.data.label : undefined, 'Peer label')
  assert.deepEqual(undone.skipped, [])
})

test('undo SKIPS a field a peer changed since — never reverts their work', () => {
  const { base, http } = httpFixture()
  const mine = updateNode(base, { ...http, data: { ...http.data, url: 'https://mine.test' } })
  const forward = diffFlowGraphs(base, mine, 'op1')

  const mineNode = httpNodeIn(mine, http.id)
  const peer = updateNode(mine, { ...mineNode, data: { ...mineNode.data, url: 'https://peer.test' } })

  const undone = applyPatchStrict(peer, invertPatch(forward, 'undo1'))

  assert.equal(urlOf(undone.graph, http.id), 'https://peer.test')
  assert.deepEqual(undone.skipped, [`node:${http.id}.url`])
})

test('undoing an add removes the node; undoing a delete restores it', () => {
  const base = emptyGraph()
  const added = insertNodeAfter(base, 'trigger', 'stop').graph
  const stopId = added.nodes.find((n) => n.type === 'stop')!.id
  const addPatch = diffFlowGraphs(base, added, 'add')

  const unAdded = applyPatchStrict(added, invertPatch(addPatch, 'undo-add'))
  assert.equal(unAdded.graph.nodes.some((n) => n.id === stopId), false)
  assert.deepEqual(unAdded.skipped, [])

  const reAdded = applyPatchStrict(unAdded.graph, addPatch)
  assert.equal(reAdded.graph.nodes.some((n) => n.id === stopId), true)
  assert.deepEqual(reAdded.skipped, [])
})

test('undo of an edit skips entirely when a peer deleted the node', () => {
  const { base, http } = httpFixture()
  const mine = updateNode(base, { ...http, data: { ...http.data, url: 'https://mine.test' } })
  const forward = diffFlowGraphs(base, mine, 'op1')

  const peerDeleted: FlowGraph = {
    ...mine,
    nodes: mine.nodes.filter((n) => n.id !== http.id),
    edges: mine.edges.filter((e) => e.source !== http.id && e.target !== http.id),
  }

  const undone = applyPatchStrict(peerDeleted, invertPatch(forward, 'undo1'))

  assert.equal(undone.graph.nodes.some((n) => n.id === http.id), false)
  assert.deepEqual(undone.skipped, [`node:${http.id}`])
})

test('undoing a drag restores position unless a peer moved the node since', () => {
  const { base, http } = httpFixture()
  const dragged: FlowGraph = { ...base, layout: { [http.id]: { x: 100, y: 100 } } }
  const forward = diffFlowGraphs(base, dragged, 'drag')

  const undone = applyPatchStrict(dragged, invertPatch(forward, 'undo1'))
  assert.equal(undone.graph.layout?.[http.id], undefined)
  assert.deepEqual(undone.skipped, [])

  const peerMoved: FlowGraph = { ...dragged, layout: { [http.id]: { x: 999, y: 999 } } }
  const skippedUndo = applyPatchStrict(peerMoved, invertPatch(forward, 'undo2'))
  assert.deepEqual(skippedUndo.graph.layout?.[http.id], { x: 999, y: 999 })
  assert.deepEqual(skippedUndo.skipped, [`layout:${http.id}`])
})

test('undoing a node add drops edges that pointed at it', () => {
  const base = emptyGraph()
  const added = insertNodeAfter(base, 'trigger', 'stop').graph
  const stopId = added.nodes.find((n) => n.type === 'stop')!.id
  assert.equal(added.edges.some((e) => e.target === stopId), true)

  const undone = applyPatchStrict(added, invertPatch(diffFlowGraphs(base, added, 'add'), 'undo'))
  assert.equal(undone.graph.edges.some((e) => e.source === stopId || e.target === stopId), false)
})
