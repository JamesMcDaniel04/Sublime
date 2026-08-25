/**
 * Flow-owned vector collections.
 *
 * The platform already embeds and searches for AGENT knowledge (lib/rag). What
 * flows could not do is build and query their own index — the "embed these
 * support tickets, then find the three most similar" shape that is most of
 * what a retrieval step is for.
 *
 * Two properties decide whether this is safe and useful:
 *
 *   1. a search never crosses workspaces;
 *   2. a dimension mismatch fails loudly. Embedding with one model and
 *      searching an index built by another returns plausible nonsense —
 *      results ranked by a similarity that means nothing — which is the worst
 *      failure mode a retrieval system has, because it looks like it worked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCollection,
  assertEmbeddingDimension,
  VECTOR_DIM,
  scoreToDistance,
  distanceToScore,
} from '../collection'

// ── collection names ────────────────────────────────────────────────────────

test('an ordinary name is kept', () => {
  assert.equal(normalizeCollection('support-tickets'), 'support-tickets')
})

test('a name is normalised so casing and padding cannot fork a collection', () => {
  assert.equal(normalizeCollection('  Support-Tickets  '), 'support-tickets')
})

// A collection name reaches a WHERE clause. It is parameterised rather than
// interpolated, but a name that can contain anything also means two flows can
// disagree about which collection they are addressing.
test('a name with unusable characters is refused', () => {
  assert.throws(() => normalizeCollection('tickets; drop table'), /collection name/i)
  assert.throws(() => normalizeCollection('a/b'), /collection name/i)
  assert.throws(() => normalizeCollection(''), /collection name/i)
  assert.throws(() => normalizeCollection('   '), /collection name/i)
})

test('an absurdly long name is refused rather than silently truncated', () => {
  // Truncating would make two distinct collections resolve to one.
  assert.throws(() => normalizeCollection('x'.repeat(200)), /collection name/i)
})

// ── dimension safety ────────────────────────────────────────────────────────

test('a correctly sized embedding passes', () => {
  assert.doesNotThrow(() => assertEmbeddingDimension(new Array(VECTOR_DIM).fill(0.1)))
})

// The failure this exists to prevent: a 1536-dim OpenAI vector written into a
// 1024-dim index, or searched against one.
test('a wrongly sized embedding is refused with both numbers named', () => {
  assert.throws(
    () => assertEmbeddingDimension(new Array(1536).fill(0.1)),
    (error: Error) => /1536/.test(error.message) && new RegExp(String(VECTOR_DIM)).test(error.message),
  )
})

test('an empty embedding is refused', () => {
  assert.throws(() => assertEmbeddingDimension([]), /dimension/i)
})

// A vector containing NaN poisons every distance it takes part in, and
// Postgres will not tell you why the ranking is nonsense.
test('a vector with a non-finite value is refused', () => {
  const bad = new Array(VECTOR_DIM).fill(0.1)
  bad[7] = NaN
  assert.throws(() => assertEmbeddingDimension(bad), /finite/i)

  const infinite = new Array(VECTOR_DIM).fill(0.1)
  infinite[3] = Infinity
  assert.throws(() => assertEmbeddingDimension(infinite), /finite/i)
})

test('a non-array is refused rather than coerced', () => {
  assert.throws(() => assertEmbeddingDimension(null as never), /dimension/i)
  assert.throws(() => assertEmbeddingDimension('vector' as never), /dimension/i)
})

// ── score conversion ────────────────────────────────────────────────────────
//
// pgvector's <=> returns cosine DISTANCE (0 = identical). People think in
// similarity (1 = identical), so the boundary converts rather than leaking the
// operator's convention into flow configuration.

test('an identical vector is distance 0 and score 1', () => {
  assert.equal(distanceToScore(0), 1)
  assert.equal(scoreToDistance(1), 0)
})

test('an opposite vector is distance 2 and score -1', () => {
  assert.equal(distanceToScore(2), -1)
  assert.equal(scoreToDistance(-1), 2)
})

test('the conversion round-trips', () => {
  for (const score of [1, 0.75, 0.5, 0, -0.5, -1]) {
    assert.ok(Math.abs(distanceToScore(scoreToDistance(score)) - score) < 1e-9, `round trip failed at ${score}`)
  }
})

// A threshold expressed as similarity must translate to the right direction of
// comparison — getting this backwards returns the LEAST similar results.
test('a higher score means a smaller distance', () => {
  assert.ok(scoreToDistance(0.9) < scoreToDistance(0.5))
})
