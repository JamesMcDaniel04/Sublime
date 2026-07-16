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

test('a drag (layout-only change) produces a real, non-topology patch', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph
  const moved: FlowGraph = { ...base, layout: { trigger: { x: 40, y: 200 } } }
  const patch = diffFlowGraphs(base, moved, 'm1')

  assert.equal(patchIsEmpty(patch), false)
  assert.equal(patchChangesTopology(patch), false)
  const applied = applyFlowCollaborationPatch(base, patch)
  assert.deepEqual(applied.graph.layout, { trigger: { x: 40, y: 200 } })
  assert.deepEqual(applied.conflicts, [])
})

test('applying a node edit preserves stored layout (regression: layout wipe)', () => {
  const base: FlowGraph = {
    ...insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph,
    layout: { trigger: { x: 10, y: 20 } },
  }
  const stop = base.nodes.find((node) => node.type === 'stop')!
  const edited = updateNode(base, { ...stop, data: { ...stop.data, reason: 'done' } })
  const applied = applyFlowCollaborationPatch(base, diffFlowGraphs(base, edited, 'm1'))

  assert.deepEqual(applied.graph.layout, { trigger: { x: 10, y: 20 } })
})

test('concurrent drags of different nodes both survive', () => {
  const base: FlowGraph = {
    ...insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph,
    layout: { trigger: { x: 0, y: 0 } },
  }
  const stopId = base.nodes.find((node) => node.type === 'stop')!.id
  const alice: FlowGraph = { ...base, layout: { ...base.layout, trigger: { x: 100, y: 50 } } }
  const bob: FlowGraph = { ...base, layout: { ...base.layout, [stopId]: { x: 400, y: 300 } } }

  const afterAlice = applyFlowCollaborationPatch(base, diffFlowGraphs(base, alice, 'alice')).graph
  const merged = applyFlowCollaborationPatch(afterAlice, diffFlowGraphs(base, bob, 'bob')).graph

  assert.deepEqual(merged.layout, { trigger: { x: 100, y: 50 }, [stopId]: { x: 400, y: 300 } })
})

test('deleting a node drops its layout entry', () => {
  const withStop = insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph
  const stopId = withStop.nodes.find((node) => node.type === 'stop')!.id
  const base: FlowGraph = { ...withStop, layout: { trigger: { x: 0, y: 0 }, [stopId]: { x: 9, y: 9 } } }
  const deleted: FlowGraph = {
    ...base,
    nodes: base.nodes.filter((node) => node.id !== stopId),
    edges: base.edges.filter((edge) => edge.source !== stopId && edge.target !== stopId),
  }
  const applied = applyFlowCollaborationPatch(base, diffFlowGraphs(base, deleted, 'm1')).graph

  assert.deepEqual(applied.layout, { trigger: { x: 0, y: 0 } })
})

// ── Per-field merge ─────────────────────────────────────────────────────────

test('editing one data field produces a field-level change, not a whole-node change', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const edited = updateNode(base, { ...http, data: { ...http.data, url: 'https://alice.test' } })
  const patch = diffFlowGraphs(base, edited, 'm1')

  assert.equal(patch.nodes.length, 0)
  assert.equal(patch.nodeFields.length, 1)
  assert.equal(patch.nodeFields[0].id, http.id)
  assert.deepEqual(
    patch.nodeFields[0].fields.map((field) => field.key),
    ['url'],
  )
  assert.equal(patchChangesTopology(patch), false)
  assert.equal(patchIsEmpty(patch), false)
})

test('two peers editing DIFFERENT fields of the same node both win, no conflict', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const alice = updateNode(base, { ...http, data: { ...http.data, url: 'https://alice.test' } })
  const bob = updateNode(base, { ...http, data: { ...http.data, label: 'Bob named me' } })

  const afterAlice = applyFlowCollaborationPatch(base, diffFlowGraphs(base, alice, 'alice')).graph
  const merged = applyFlowCollaborationPatch(afterAlice, diffFlowGraphs(base, bob, 'bob'))

  const node = merged.graph.nodes.find((n) => n.id === http.id)
  assert.equal(node?.type === 'http' ? node.data.url : undefined, 'https://alice.test')
  assert.equal(node?.type === 'http' ? node.data.label : undefined, 'Bob named me')
  assert.deepEqual(merged.conflicts, [])
})

test('same-field concurrent edits conflict and the incoming edit wins', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const alice = updateNode(base, { ...http, data: { ...http.data, url: 'https://alice.test' } })
  const bob = updateNode(base, { ...http, data: { ...http.data, url: 'https://bob.test' } })

  const afterAlice = applyFlowCollaborationPatch(base, diffFlowGraphs(base, alice, 'alice')).graph
  const merged = applyFlowCollaborationPatch(afterAlice, diffFlowGraphs(base, bob, 'bob'))

  const node = merged.graph.nodes.find((n) => n.id === http.id)
  assert.equal(node?.type === 'http' ? node.data.url : undefined, 'https://bob.test')
  assert.deepEqual(merged.conflicts, [`node:${http.id}.url`])
})

test('a field edit against a peer-deleted node conflicts and the node stays deleted', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const edited = updateNode(base, { ...http, data: { ...http.data, url: 'https://alice.test' } })
  const deleted: FlowGraph = {
    ...base,
    nodes: base.nodes.filter((node) => node.id !== http.id),
    edges: base.edges.filter((edge) => edge.source !== http.id && edge.target !== http.id),
  }

  const afterDelete = applyFlowCollaborationPatch(base, diffFlowGraphs(base, deleted, 'del')).graph
  const merged = applyFlowCollaborationPatch(afterDelete, diffFlowGraphs(base, edited, 'edit'))

  assert.equal(merged.graph.nodes.some((node) => node.id === http.id), false)
  assert.deepEqual(merged.conflicts, [`node:${http.id}`])
})

test('removing a data key falls back to a whole-node change', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const withLabel = updateNode(base, { ...http, data: { ...http.data, label: 'temp' } })
  const labelNode = withLabel.nodes.find((node) => node.id === http.id)!
  const { label: _dropped, ...rest } = labelNode.data as Record<string, unknown>
  const removed = updateNode(withLabel, { ...labelNode, data: rest } as never)

  const patch = diffFlowGraphs(withLabel, removed, 'm1')
  assert.equal(patch.nodeFields.length, 0)
  assert.equal(patch.nodes.length, 1)
})

test('a node type change is a whole-node change, never field-level', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph
  const stopId = base.nodes.find((node) => node.type === 'stop')!.id
  const swapped: FlowGraph = {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === stopId ? { id: stopId, type: 'http' as const, data: { url: '', method: 'GET' as const } } : node,
    ),
  }
  const patch = diffFlowGraphs(base, swapped, 'm1')
  assert.equal(patch.nodeFields.length, 0)
  assert.equal(patch.nodes.length, 1)
  assert.equal(patchChangesTopology(patch), true)
})

test('a field patch that would break the node schema is rejected as a conflict', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const http = base.nodes.find((node) => node.type === 'http')!
  const patch = {
    mutationId: 'evil',
    nodes: [],
    edges: [],
    layout: [],
    nodeFields: [{ id: http.id, type: 'http', fields: [{ key: 'url', before: (http.data as { url: string }).url, after: 42 }] }],
  }
  const applied = applyFlowCollaborationPatch(base, patch as never)

  const node = applied.graph.nodes.find((n) => n.id === http.id)
  assert.equal(node?.type === 'http' ? node.data.url : undefined, (http.data as { url: string }).url)
  assert.deepEqual(applied.conflicts, [`node:${http.id}`])
})

test('patches without a layout field (older clients) still parse and apply', () => {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'stop').graph
  const stop = base.nodes.find((node) => node.type === 'stop')!
  const legacyPatch = {
    mutationId: 'legacy',
    nodes: [{ id: stop.id, before: stop, after: { ...stop, data: { ...stop.data, reason: 'legacy' } } }],
    edges: [],
  }
  const applied = applyFlowCollaborationPatch(base, legacyPatch as never)
  const mergedStop = applied.graph.nodes.find((node) => node.id === stop.id)
  assert.equal(mergedStop?.type === 'stop' ? mergedStop.data.reason : undefined, 'legacy')
})
