import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isDuplicateTemplate,
  pickTemplatesToEvict,
  MAX_AUTO_TEMPLATES_PER_ORG,
  DUPLICATE_SIMILARITY_THRESHOLD,
} from '../template-from-run'

test('isDuplicateTemplate: empty candidate embedding never matches', () => {
  assert.equal(isDuplicateTemplate([], [[1, 0, 0]]), false)
})

test('isDuplicateTemplate: no existing embeddings never matches', () => {
  assert.equal(isDuplicateTemplate([1, 0, 0], []), false)
})

test('isDuplicateTemplate: identical vectors are a duplicate', () => {
  assert.equal(isDuplicateTemplate([1, 0, 0], [[0, 1, 0], [1, 0, 0]]), true)
})

test('isDuplicateTemplate: below-threshold similarity is not a duplicate', () => {
  // Orthogonal vectors have cosine similarity 0.
  assert.equal(isDuplicateTemplate([1, 0], [[0, 1]]), false)
})

test('isDuplicateTemplate: respects a custom threshold', () => {
  const candidate = [1, 1]
  const existing = [[1, 0]] // cosine ~0.707
  assert.equal(isDuplicateTemplate(candidate, existing, 0.9), false)
  assert.equal(isDuplicateTemplate(candidate, existing, 0.5), true)
})

test('isDuplicateTemplate: default threshold matches the documented constant', () => {
  assert.equal(DUPLICATE_SIMILARITY_THRESHOLD, 0.86)
})

test('pickTemplatesToEvict: under the cap evicts nothing', () => {
  const existing = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, createdAt: new Date(2020, 0, i + 1) }))
  assert.deepEqual(pickTemplatesToEvict(existing, 20), [])
})

test('pickTemplatesToEvict: at the cap evicts the single oldest to make room for one new row', () => {
  const existing = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, createdAt: new Date(2020, 0, i + 1) }))
  const evicted = pickTemplatesToEvict(existing, 20)
  assert.deepEqual(evicted, ['t0'])
})

test('pickTemplatesToEvict: over the cap evicts every excess oldest row', () => {
  const existing = Array.from({ length: 23 }, (_, i) => ({ id: `t${i}`, createdAt: new Date(2020, 0, i + 1) }))
  const evicted = pickTemplatesToEvict(existing, 20)
  // Keep 19 newest (cap - 1), evict the 4 oldest.
  assert.deepEqual(evicted, ['t0', 't1', 't2', 't3'])
})

test('pickTemplatesToEvict: evicts oldest by createdAt regardless of input order', () => {
  const existing = [
    { id: 'newest', createdAt: new Date(2024, 0, 1) },
    { id: 'oldest', createdAt: new Date(2020, 0, 1) },
    { id: 'middle', createdAt: new Date(2022, 0, 1) },
  ]
  assert.deepEqual(pickTemplatesToEvict(existing, 3), ['oldest'])
})

test('MAX_AUTO_TEMPLATES_PER_ORG is the documented cap', () => {
  assert.equal(MAX_AUTO_TEMPLATES_PER_ORG, 20)
})
