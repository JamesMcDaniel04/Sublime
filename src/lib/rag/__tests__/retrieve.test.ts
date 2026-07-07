import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '../memory-store'
import { retrieveContext, renderContext } from '../retrieve'
import type { GraphNode } from '../store'

function node(id: string, type: GraphNode['type'], embedding: number[], text: string): GraphNode {
  return { id, organizationId: 'org1', type, text, props: {}, embedding }
}

// Deterministic fake embedder: maps known phrases to vectors, so retrieval is
// testable without the network.
const vectors: Record<string, number[]> = {
  'deal risk falken': [1, 0, 0],
  risk: [0.95, 0.1, 0],
  unrelated: [0, 0, 1],
}
const fakeEmbed = async (text: string) => vectors[text] ?? [0, 0, 0]

async function seededStore() {
  const store = new MemoryGraphStore()
  await store.upsertNodes([
    node('signal1', 'signal', [1, 0, 0], 'deal.risk_detected on Falken Group — high risk'),
    node('acct1', 'account', [0.2, 0.2, 0], 'Account: Falken Group'),
    node('opp1', 'opportunity', [0.3, 0.1, 0], 'Opportunity: Falken renewal $402k'),
    node('run1', 'run', [0.1, 0.9, 0], 'Run: drafted a check-in email via Gmail'),
    node('noise', 'insight', [0, 0, 1], 'Unrelated marketing note'),
  ])
  await store.upsertEdges([
    { organizationId: 'org1', from: 'signal1', to: 'acct1', rel: 'about_account' },
    { organizationId: 'org1', from: 'opp1', to: 'acct1', rel: 'belongs_to' },
    { organizationId: 'org1', from: 'signal1', to: 'run1', rel: 'triggered_run' },
  ])
  return store
}

test('retrieveContext returns semantic hits and their connected neighborhood', async () => {
  const store = await seededStore()
  const ctx = await retrieveContext(store, {
    organizationId: 'org1', query: 'risk', embed: fakeEmbed, topK: 1, hops: 2,
  })
  // Top hit is the risk signal…
  assert.equal(ctx.hits[0].id, 'signal1')
  // …and expansion pulls in the correlated account, its opportunity, and the run.
  const relatedIds = ctx.related.map((r) => r.id).sort()
  assert.deepEqual(relatedIds, ['acct1', 'opp1', 'run1'])
  // The unrelated node is neither a hit nor connected.
  assert.ok(!ctx.related.some((r) => r.id === 'noise'))
})

test('seedNodeIds expand even without a strong vector hit', async () => {
  const store = await seededStore()
  const ctx = await retrieveContext(store, {
    organizationId: 'org1', query: 'unrelated', embed: fakeEmbed, topK: 1, hops: 1,
    seedNodeIds: ['acct1'],
  })
  const relatedIds = ctx.related.map((r) => r.id)
  assert.ok(relatedIds.includes('signal1') && relatedIds.includes('opp1'))
})

test('retrieveContext never throws when the store search fails', async () => {
  const brokenStore = {
    upsertNodes: async () => {}, upsertEdges: async () => {},
    search: async () => { throw new Error('store down') },
    expand: async () => { throw new Error('store down') },
    deleteNodes: async () => {}, deleteByOwner: async () => {},
  }
  const ctx = await retrieveContext(brokenStore, { organizationId: 'org1', query: 'risk', embed: fakeEmbed })
  assert.deepEqual(ctx, { hits: [], related: [] })
})

test('renderContext produces empty string for an empty pack, markdown otherwise', async () => {
  assert.equal(renderContext({ hits: [], related: [] }), '')
  const store = await seededStore()
  const ctx = await retrieveContext(store, { organizationId: 'org1', query: 'risk', embed: fakeEmbed, topK: 1 })
  const md = renderContext(ctx)
  assert.match(md, /Correlated context/)
  assert.match(md, /Falken/)
})
