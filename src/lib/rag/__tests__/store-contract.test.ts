import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '../memory-store'
import type { GraphNode } from '../store'

function node(id: string, org: string, type: GraphNode['type'], embedding: number[], text = id): GraphNode {
  return { id, organizationId: org, type, text, props: {}, embedding }
}

test('search returns top-k by similarity, scoped to the org', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    node('a', 'org1', 'signal', [1, 0]),
    node('b', 'org1', 'signal', [0.9, 0.1]),
    node('c', 'org1', 'signal', [0, 1]),
    node('x', 'org2', 'signal', [1, 0]), // other org — must not appear
  ])
  const hits = await store.search('org1', null, [1, 0], 2)
  assert.deepEqual(hits.map((h) => h.node.id), ['a', 'b'])
  assert.ok(!hits.some((h) => h.node.organizationId === 'org2'))
})

test('expand walks edges undirected and excludes the seeds', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    node('signal1', 'org1', 'signal', [1, 0]),
    node('run1', 'org1', 'run', [0, 1]),
    node('agent1', 'org1', 'agent', [0.5, 0.5]),
    node('acct1', 'org1', 'account', [0.2, 0.2]),
  ])
  await store.upsertEdges([
    { organizationId: 'org1', from: 'signal1', to: 'run1', rel: 'triggered_run' },
    { organizationId: 'org1', from: 'run1', to: 'agent1', rel: 'ran_agent' },
    { organizationId: 'org1', from: 'signal1', to: 'acct1', rel: 'about_account' },
  ])
  // 1 hop from signal1 → run1 + acct1 (not agent1, which is 2 hops)
  const oneHop = await store.expand('org1', null, ['signal1'], 1)
  assert.deepEqual(oneHop.map((n) => n.id).sort(), ['acct1', 'run1'])
  // 2 hops reaches agent1 too
  const twoHop = await store.expand('org1', null, ['signal1'], 2)
  assert.deepEqual(twoHop.map((n) => n.id).sort(), ['acct1', 'agent1', 'run1'])
})

test('upsert is idempotent for nodes and edges', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0], 'first')])
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0], 'updated')])
  const hits = await store.search('org1', null, [1, 0], 5)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].node.text, 'updated')

  await store.upsertNodes([node('b', 'org1', 'run', [0, 1])])
  await store.upsertEdges([{ organizationId: 'org1', from: 'a', to: 'b', rel: 'triggered_run' }])
  await store.upsertEdges([{ organizationId: 'org1', from: 'a', to: 'b', rel: 'triggered_run' }])
  const neighbors = await store.expand('org1', null, ['a'], 1)
  assert.deepEqual(neighbors.map((n) => n.id), ['b'])
})

test('clear removes only the target org', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('a', 'org1', 'signal', [1, 0]), node('b', 'org2', 'signal', [1, 0])])
  await store.clear('org1')
  assert.equal((await store.search('org1', null, [1, 0], 5)).length, 0)
  assert.equal((await store.search('org2', null, [1, 0], 5)).length, 1)
})

// ── Per-rep visibility scoping ──────────────────────────────────────────────
function ownedNode(id: string, ownerUserId: string | null, visibility: 'shared' | 'private', embedding = [1, 0]): GraphNode {
  return { id, organizationId: 'org1', type: 'account', text: id, props: {}, embedding, ownerUserId, visibility }
}

test('search hides private nodes from non-owners, shows shared to everyone', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    ownedNode('shared', null, 'shared'),
    ownedNode('repA-private', 'repA', 'private'),
    ownedNode('repB-private', 'repB', 'private'),
  ])

  // Rep A sees shared + their own private, never rep B's.
  const asA = await store.search('org1', 'repA', [1, 0], 10)
  assert.deepEqual(asA.map((h) => h.node.id).sort(), ['repA-private', 'shared'])

  // Rep B symmetric.
  const asB = await store.search('org1', 'repB', [1, 0], 10)
  assert.deepEqual(asB.map((h) => h.node.id).sort(), ['repB-private', 'shared'])

  // A null viewer (system/no-user) sees only shared.
  const asNull = await store.search('org1', null, [1, 0], 10)
  assert.deepEqual(asNull.map((h) => h.node.id), ['shared'])
})

test('deleteNodes removes nodes + edges; deleteByOwner removes only that rep', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    ownedNode('shared', null, 'shared'),
    ownedNode('repA-private', 'repA', 'private'),
    ownedNode('repB-private', 'repB', 'private'),
  ])
  await store.upsertEdges([{ organizationId: 'org1', from: 'shared', to: 'repA-private', rel: 'about_account' }])

  await store.deleteNodes('org1', ['shared'])
  assert.equal((await store.search('org1', null, [1, 0], 10)).some((h) => h.node.id === 'shared'), false)
  // The edge from the deleted node is gone too.
  assert.deepEqual(await store.expand('org1', 'repA', ['shared'], 1), [])

  await store.deleteByOwner('org1', 'repA')
  assert.equal((await store.search('org1', 'repA', [1, 0], 10)).some((h) => h.node.id === 'repA-private'), false)
  // Another rep's private node is untouched.
  assert.equal((await store.search('org1', 'repB', [1, 0], 10)).some((h) => h.node.id === 'repB-private'), true)
})

test('expand never surfaces another rep\'s private neighbor', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    ownedNode('seed', null, 'shared', [0.1, 0.1]),
    ownedNode('repA-private', 'repA', 'private'),
    ownedNode('repB-private', 'repB', 'private'),
  ])
  await store.upsertEdges([
    { organizationId: 'org1', from: 'seed', to: 'repA-private', rel: 'about_account' },
    { organizationId: 'org1', from: 'seed', to: 'repB-private', rel: 'about_account' },
  ])
  // Expanding from the shared seed as rep A reaches only A's private neighbor.
  const asA = await store.expand('org1', 'repA', ['seed'], 1)
  assert.deepEqual(asA.map((n) => n.id), ['repA-private'])
  // As a null viewer, neither private neighbor is returned.
  const asNull = await store.expand('org1', null, ['seed'], 1)
  assert.deepEqual(asNull.map((n) => n.id), [])
})
