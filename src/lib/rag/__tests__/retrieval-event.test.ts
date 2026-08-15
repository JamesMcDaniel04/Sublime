import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextRetrievedPayload, buildKnowledgeRetrievedPayload } from '../retrieval-event'

const trace = {
  candidates: 12, afterScoreFloor: 7, reranked: true, afterRerank: 5,
  graphSeeds: 5, relatedFound: 9, relatedKept: 4, minScore: 0.25, topK: 6, hops: 2,
}

test('strategy derives from the funnel', () => {
  const payload = buildContextRetrievedPayload({
    query: 'renewal risk for Acme', trace,
    hits: [{ type: 'opportunity', text: 'Acme renewal', score: 0.87 }],
    related: [], offeredHits: 5, injectedChars: 8400,
  })
  assert.equal(payload.strategy, 'vector+rerank+graph')
  assert.equal(payload.injected.count, 1)
  assert.equal(payload.injected.ofCandidates, 5)
  assert.equal(payload.injected.tokens, 2100) // chars/4
  assert.ok(payload.summary.includes('1'))
})

test('strategy is plain vector when nothing else ran', () => {
  const payload = buildContextRetrievedPayload({
    query: 'q', trace: { ...trace, reranked: false, graphSeeds: 0 },
    hits: [], related: [], offeredHits: 0, injectedChars: 0,
  })
  assert.equal(payload.strategy, 'vector')
})

test('knowledge payload keeps filenames unique and scores per chunk', () => {
  const payload = buildKnowledgeRetrievedPayload({
    query: 'pricing', offered: 6, injectedChars: 2000,
    chunks: [
      { filename: 'deck.pdf', score: 0.8 },
      { filename: 'deck.pdf', score: 0.7 },
      { filename: 'notes.md', score: 0.6 },
    ],
  })
  assert.deepEqual(payload.files, ['deck.pdf', 'notes.md'])
  assert.equal(payload.chunks.length, 3)
  assert.equal(payload.injected.tokens, 500)
})
