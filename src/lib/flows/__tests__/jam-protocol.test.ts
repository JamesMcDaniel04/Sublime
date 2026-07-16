/**
 * Two-client protocol integration test: an in-memory sequencer that mirrors
 * POST /api/flows/[id]/collaboration (revision numbers, mutation-log dedup,
 * topology-conflict rejection) plus client models that mirror the hook's
 * baseline/pending-rebase behavior. Replays the interleavings that made the
 * MVP feel broken and asserts everyone converges to the same graph.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyGraph, type FlowGraph } from '../graph'
import { insertNodeAfter, updateNode } from '../mutate'
import {
  applyFlowCollaborationPatch,
  diffFlowGraphs,
  patchChangesTopology,
  patchIsEmpty,
  type FlowCollaborationPatch,
} from '../collaboration'
import { appendMutation, hasAppliedMutation } from '../mutation-log'
import { applyPatchStrict, invertPatch } from '../undo'

const clone = (graph: FlowGraph): FlowGraph => JSON.parse(JSON.stringify(graph))
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** Mirrors the collaboration route's sequencing rules. */
class Sequencer {
  graph: FlowGraph
  revision = 0
  private log: string[] = []

  constructor(graph: FlowGraph) {
    this.graph = clone(graph)
  }

  post(baseRevision: number, patch: FlowCollaborationPatch) {
    if (hasAppliedMutation(this.log, patch.mutationId)) {
      return { ok: true, graph: clone(this.graph), revision: this.revision, conflicts: [] as string[] }
    }
    if (baseRevision !== this.revision && patchChangesTopology(patch)) {
      return { ok: false, graph: clone(this.graph), revision: this.revision, conflicts: [] as string[] }
    }
    const applied = applyFlowCollaborationPatch(this.graph, patch)
    if (same(applied.graph, this.graph)) {
      return { ok: true, graph: clone(this.graph), revision: this.revision, conflicts: applied.conflicts }
    }
    this.graph = applied.graph
    this.revision += 1
    this.log = appendMutation(this.log, patch.mutationId)
    return { ok: true, graph: clone(this.graph), revision: this.revision, conflicts: applied.conflicts }
  }
}

/** Mirrors the hook's baseline / pending-local / rebase-on-remote behavior. */
class Client {
  baseline: FlowGraph
  local: FlowGraph
  revision: number
  private seq = 0
  readonly undoStack: { forward: FlowCollaborationPatch; inverse: FlowCollaborationPatch }[] = []

  constructor(readonly id: string, server: Sequencer) {
    this.baseline = clone(server.graph)
    this.local = clone(server.graph)
    this.revision = server.revision
  }

  /** A local commit, recorded in undo history (mirrors commitGraph). */
  edit(mutate: (graph: FlowGraph) => FlowGraph) {
    const next = mutate(this.local)
    const seq = ++this.seq
    const forward = diffFlowGraphs(this.local, next, `${this.id}:op:${seq}`)
    if (!patchIsEmpty(forward)) {
      this.undoStack.push({ forward, inverse: invertPatch(forward, `${this.id}:op:${seq}:inverse`) })
    }
    this.local = next
  }

  undo() {
    const entry = this.undoStack.pop()
    if (!entry) return { skipped: [] as string[] }
    const { graph, skipped } = applyPatchStrict(this.local, entry.inverse)
    this.local = graph
    return { skipped }
  }

  /** Mirrors flushPatch: diff vs baseline, POST, adopt the server's answer. */
  flush(server: Sequencer, mutationId?: string) {
    const patch = diffFlowGraphs(this.baseline, this.local, mutationId ?? `${this.id}:flush:${++this.seq}`)
    if (patchIsEmpty(patch)) return { ok: true, conflicts: [] as string[], patch }
    const response = server.post(this.revision, patch)
    this.baseline = clone(response.graph)
    this.local = clone(response.graph)
    this.revision = response.revision
    return { ok: response.ok, conflicts: response.conflicts, patch }
  }

  /** Mirrors acceptServerGraph: rebase pending local work onto the broadcast. */
  receive(server: Sequencer) {
    if (server.revision < this.revision) return
    const pending = diffFlowGraphs(this.baseline, this.local, `${this.id}:rebase`)
    let next = clone(server.graph)
    if (!patchIsEmpty(pending)) next = applyFlowCollaborationPatch(next, pending).graph
    this.baseline = clone(server.graph)
    this.local = next
    this.revision = server.revision
  }
}

function fixture() {
  const base = insertNodeAfter(emptyGraph(), 'trigger', 'http').graph
  const server = new Sequencer(base)
  const alice = new Client('alice', server)
  const bob = new Client('bob', server)
  const httpId = base.nodes.find((node) => node.type === 'http')!.id
  return { server, alice, bob, httpId }
}

function httpData(graph: FlowGraph, id: string): Record<string, unknown> | undefined {
  const node = graph.nodes.find((n) => n.id === id)
  return node?.type === 'http' ? (node.data as Record<string, unknown>) : undefined
}

/** Narrowed lookup so `data` spreads type-check against the http node member. */
function httpNode(graph: FlowGraph, id: string) {
  const node = graph.nodes.find((n) => n.type === 'http' && n.id === id)
  if (!node || node.type !== 'http') throw new Error(`missing http node ${id}`)
  return node
}

const setUrl = (id: string, url: string) => (g: FlowGraph) => {
  const node = httpNode(g, id)
  return updateNode(g, { ...node, data: { ...node.data, url } })
}
const setLabel = (id: string, label: string) => (g: FlowGraph) => {
  const node = httpNode(g, id)
  return updateNode(g, { ...node, data: { ...node.data, label } })
}

test('different-field edits from two clients converge with both edits intact', () => {
  const { server, alice, bob, httpId } = fixture()

  alice.edit(setUrl(httpId, 'https://alice.test'))
  bob.edit(setLabel(httpId, 'Bob named me'))

  assert.equal(alice.flush(server).conflicts.length, 0)
  assert.equal(bob.flush(server).conflicts.length, 0)
  alice.receive(server)
  bob.receive(server)

  assert.equal(httpData(server.graph, httpId)?.url, 'https://alice.test')
  assert.equal(httpData(server.graph, httpId)?.label, 'Bob named me')
  assert.deepEqual(alice.local, server.graph)
  assert.deepEqual(bob.local, server.graph)
})

test('same-field edits conflict once, later writer wins, everyone converges', () => {
  const { server, alice, bob, httpId } = fixture()

  alice.edit(setUrl(httpId, 'https://alice.test'))
  bob.edit(setUrl(httpId, 'https://bob.test'))

  alice.flush(server)
  const bobResult = bob.flush(server)
  assert.deepEqual(bobResult.conflicts, [`node:${httpId}.url`])

  alice.receive(server)
  assert.equal(httpData(alice.local, httpId)?.url, 'https://bob.test')
  assert.deepEqual(alice.local, bob.local)
})

test('delete-vs-edit: deletion wins and the editor converges to it', () => {
  const { server, alice, bob, httpId } = fixture()

  alice.edit((g) => ({
    ...g,
    nodes: g.nodes.filter((n) => n.id !== httpId),
    edges: g.edges.filter((e) => e.source !== httpId && e.target !== httpId),
  }))
  bob.edit(setUrl(httpId, 'https://bob.test'))

  alice.flush(server)
  const bobResult = bob.flush(server)
  assert.deepEqual(bobResult.conflicts, [`node:${httpId}`])
  assert.equal(server.graph.nodes.some((n) => n.id === httpId), false)
  assert.deepEqual(bob.local, server.graph)
})

test('offline work rebases over everything that happened meanwhile', () => {
  const { server, alice, bob, httpId } = fixture()

  // Bob goes offline and drags the node; Alice keeps editing and flushing.
  bob.edit((g) => ({ ...g, layout: { ...(g.layout ?? {}), [httpId]: { x: 640, y: 128 } } }))
  alice.edit(setUrl(httpId, 'https://alice.test'))
  alice.flush(server)

  // Bob reconnects: broadcast catch-up rebases his pending drag, then he flushes.
  bob.receive(server)
  assert.equal(httpData(bob.local, httpId)?.url, 'https://alice.test')
  assert.deepEqual(bob.local.layout?.[httpId], { x: 640, y: 128 })
  bob.flush(server)
  alice.receive(server)

  assert.deepEqual(server.graph.layout?.[httpId], { x: 640, y: 128 })
  assert.equal(httpData(server.graph, httpId)?.url, 'https://alice.test')
  assert.deepEqual(alice.local, bob.local)
})

test('a timed-out retry with the same mutationId applies exactly once', () => {
  const { server, alice, httpId } = fixture()

  alice.edit(setUrl(httpId, 'https://alice.test'))
  const patch = diffFlowGraphs(alice.baseline, alice.local, 'alice:retry-me')

  const first = server.post(alice.revision, patch)
  const retry = server.post(alice.revision, patch)

  assert.equal(first.revision, 1)
  assert.equal(retry.revision, 1)
  assert.deepEqual(retry.conflicts, [])
  assert.deepEqual(first.graph, retry.graph)
})

test('a stale topology change is rejected, non-topology edits still land', () => {
  const { server, alice, bob, httpId } = fixture()

  alice.edit((g) => insertNodeAfter(g, httpId, 'stop').graph)
  alice.flush(server)

  // Bob, still on revision 0, tries a structural insert → rejected; then a
  // field edit from the same stale revision → accepted.
  bob.edit((g) => insertNodeAfter(g, httpId, 'stop').graph)
  const structural = bob.flush(server)
  assert.equal(structural.ok, false)

  bob.edit(setUrl(httpId, 'https://bob.test'))
  const fieldEdit = bob.flush(server)
  assert.equal(fieldEdit.ok, true)
  assert.equal(httpData(server.graph, httpId)?.url, 'https://bob.test')
})

test('undo after a peer deleted the node skips cleanly and stays convergent', () => {
  const { server, alice, bob, httpId } = fixture()

  alice.edit(setUrl(httpId, 'https://alice.test'))
  alice.flush(server)
  bob.receive(server)

  bob.edit((g) => ({
    ...g,
    nodes: g.nodes.filter((n) => n.id !== httpId),
    edges: g.edges.filter((e) => e.source !== httpId && e.target !== httpId),
  }))
  bob.flush(server)
  alice.receive(server)

  const { skipped } = alice.undo()
  assert.deepEqual(skipped, [`node:${httpId}`])
  assert.equal(alice.local.nodes.some((n) => n.id === httpId), false)

  alice.flush(server)
  bob.receive(server)
  assert.deepEqual(alice.local, bob.local)
})
