import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyGraph, type FlowGraph } from '../graph'
import { insertNodeAfter, updateNode } from '../mutate'
import {
  applyFlowCollaborationPatch,
  diffFlowGraphs,
  patchChangesTopology,
  patchIsEmpty,
} from '../collaboration'

test('empty graph diff is a no-op', () => {
  const graph = emptyGraph()
  assert.equal(patchIsEmpty(diffFlowGraphs(graph, graph, 'm1')), true)
})

test('node edits apply without replacing unrelated concurrent edits', () => {
  let base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  base = insertNodeAfter(base, base.nodes[1].id, 'stop').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const stop = base.nodes.find((node) => node.type === 'stop')!

  const alice = updateNode(base, { ...http, data: { ...http.data, url: 'https://alice.test' } })
  const bob = updateNode(base, { ...stop, data: { ...stop.data, reason: 'Bob was here' } })
  const afterBob = applyFlowCollaborationPatch(base, diffFlowGraphs(base, bob, 'bob')).graph
  const merged = applyFlowCollaborationPatch(afterBob, diffFlowGraphs(base, alice, 'alice'))

  assert.equal(merged.graph.nodes.find((node) => node.type === 'http')?.data.url, 'https://alice.test')
  assert.equal(merged.graph.nodes.find((node) => node.type === 'stop')?.data.reason, 'Bob was here')
  assert.deepEqual(merged.conflicts, [])
})

test('same-node concurrent edits report a conflict and incoming edit wins', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph
  const stop = base.nodes.find((node) => node.type === 'stop')!
  const alice = updateNode(base, { ...stop, data: { ...stop.data, reason: 'Alice' } })
  const bob = updateNode(base, { ...stop, data: { ...stop.data, reason: 'Bob' } })
  const afterAlice = applyFlowCollaborationPatch(base, diffFlowGraphs(base, alice, 'alice')).graph
  const merged = applyFlowCollaborationPatch(afterAlice, diffFlowGraphs(base, bob, 'bob'))

  assert.deepEqual(merged.conflicts, [`node:${stop.id}`])
  const mergedStop = merged.graph.nodes.find((node) => node.id === stop.id)
  assert.equal(mergedStop?.type === 'stop' ? mergedStop.data.reason : undefined, 'Bob')
})

test('topology changes are identified for stale-revision rejection', () => {
  const base = emptyGraph()
  const inserted = insertNodeAfter(base, 'trigger', 'stop').graph
  assert.equal(patchChangesTopology(diffFlowGraphs(base, inserted, 'm1')), true)

  const stop = inserted.nodes.find((node) => node.type === 'stop')!
  const fieldEdit = updateNode(inserted, { ...stop, data: { ...stop.data, reason: 'done' } })
  assert.equal(patchChangesTopology(diffFlowGraphs(inserted, fieldEdit, 'm2')), false)
})

test('patch application is idempotent', () => {
  const base: FlowGraph = emptyGraph()
  const inserted = insertNodeAfter(base, 'trigger', 'stop').graph
  const patch = diffFlowGraphs(base, inserted, 'm1')
  const once = applyFlowCollaborationPatch(base, patch)
  const twice = applyFlowCollaborationPatch(once.graph, patch)
  assert.deepEqual(twice.graph, once.graph)
  assert.deepEqual(twice.conflicts, [])
})
