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
  assert.deepEqual(ctx.hits, [])
  assert.deepEqual(ctx.related, [])
  assert.equal(ctx.trace.candidates, 0)
})

// ── Retrieval telemetry (trace) ──────────────────────────────────────────────

const stubStore = (overrides: Partial<Record<'search' | 'expand', (...args: never[]) => unknown>>) =>
  ({
    upsertNodes: async () => {},
    upsertEdges: async () => {},
    search: async () => [],
    expand: async () => [],
    deleteNodes: async () => {},
    deleteByOwner: async () => {},
    ...overrides,
  }) as never

test('trace records the stage funnel through the score floor', async () => {
  const hit = (id: string, score: number) => ({
    node: { id, organizationId: 'org1', type: 'signal', text: `t-${id}`, props: {} },
    score,
  })
  const store = stubStore({ search: async () => [hit('a', 0.9), hit('b', 0.5), hit('c', 0.1)] })
  const ctx = await retrieveContext(store, {
    organizationId: 'org1', query: 'q', embed: fakeEmbed, rerank: async () => null,
  })
  assert.equal(ctx.trace.candidates, 3)
  assert.equal(ctx.trace.afterScoreFloor, 2) // 0.1 < default 0.25 floor
  assert.equal(ctx.trace.reranked, false)
  assert.equal(ctx.trace.afterRerank, 2)
})

test('trace is zeros (not undefined) when retrieval is disabled', async () => {
  // No embed injected and no embeddings config in the test env → early return.
  const ctx = await retrieveContext(stubStore({}), { organizationId: 'org1', query: 'q' })
  assert.equal(ctx.trace.candidates, 0)
  assert.equal(ctx.trace.reranked, false)
  assert.equal(ctx.trace.relatedKept, 0)
})

test('trace counts graph expansion: found vs kept after maxNodes trim', async () => {
  const related = Array.from({ length: 20 }, (_, index) => ({
    id: `r${index}`, organizationId: 'org1', type: 'account', text: `node ${index}`, props: {},
  }))
  const store = stubStore({
    search: async () => [
      { node: { id: 'hit', organizationId: 'org1', type: 'signal', text: 'hit', props: {} }, score: 0.9 },
    ],
    expand: async () => related,
  })
  const ctx = await retrieveContext(store, {
    organizationId: 'org1', query: 'q', embed: fakeEmbed, maxNodes: 5, rerank: async () => null,
  })
  assert.equal(ctx.trace.relatedFound, 20)
  assert.equal(ctx.trace.relatedKept, 5)
  assert.equal(ctx.trace.graphSeeds, 1)
})

test('renderContext produces empty string for an empty pack, markdown otherwise', async () => {
  assert.equal(renderContext({ hits: [], related: [] }), '')
  const store = await seededStore()
  const ctx = await retrieveContext(store, { organizationId: 'org1', query: 'risk', embed: fakeEmbed, topK: 1 })
  const md = renderContext(ctx)
  assert.match(md, /Correlated context/)
  assert.match(md, /Falken/)
})

test('renderContext carries the citation/grounding instruction when context exists', async () => {
  const rendered = renderContext({
    hits: [{ id: 'account:a1', type: 'account', text: 'Account a1 — healthy', score: 0.9, props: {} }],
    related: [],
  })
  assert.match(rendered, /attribute it inline/)
  assert.match(rendered, /Never present a correlated fact as something you observed live/)
})

test('recencyWeight: fresh ≈ 1, 30 days ≈ half-decayed, unknown/old floor at 0.5', async () => {
  const { recencyWeight } = await import('../retrieve')
  const now = Date.parse('2026-07-11T00:00:00Z')
  assert.ok(recencyWeight(new Date(now).toISOString(), now) > 0.99)
  const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString()
  assert.ok(Math.abs(recencyWeight(thirtyDaysAgo, now) - 0.5) < 0.01)
  assert.equal(recencyWeight(undefined, now), 0.5)
  assert.equal(recencyWeight('not-a-date', now), 0.5)
  const yearAgo = new Date(now - 365 * 86_400_000).toISOString()
  assert.equal(recencyWeight(yearAgo, now), 0.5) // floored, never vanishes
})
