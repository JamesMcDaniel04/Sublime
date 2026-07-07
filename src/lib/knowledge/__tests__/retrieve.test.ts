import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosine, keywordScore, renderKnowledge } from '../retrieve'

test('cosine is 1 for identical vectors and 0 for orthogonal', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.ok(cosine([1, 1], [1, 0]) > 0.7 && cosine([1, 1], [1, 0]) < 0.72)
})

test('keywordScore reflects query-term overlap', () => {
  assert.equal(keywordScore('pricing tiers enterprise', 'Our enterprise pricing has three tiers'), 1)
  assert.equal(keywordScore('pricing tiers', 'unrelated content here'), 0)
  assert.ok(keywordScore('pricing tiers', 'pricing information') > 0 && keywordScore('pricing tiers', 'pricing information') < 1)
})

test('renderKnowledge produces an empty string for no hits, a block otherwise', () => {
  assert.equal(renderKnowledge([]), '')
  const block = renderKnowledge([{ content: 'Enterprise tier is $50k', filename: 'pricing.md', score: 0.9 }])
  assert.ok(block.includes('pricing.md'))
  assert.ok(block.includes('Enterprise tier is $50k'))
})
