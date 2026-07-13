import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInferences } from '@/lib/intelligence/infer-patterns'

const valid = new Set(['ev-1', 'ev-2'])

test('keeps inferences whose citations are real event ids', () => {
  const parsed = parseInferences(
    { inferences: [{ slug: 'legal-bottleneck', kind: 'inferred_pattern', text: 'Legal review is a bottleneck.', evidenceEventIds: ['ev-1', 'ev-2'] }] },
    valid,
  )
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].evidenceEventIds, ['ev-1', 'ev-2'])
})

test('strips hallucinated event ids; drops an inference with none left', () => {
  const parsed = parseInferences({
    inferences: [
      { slug: 'half-real', kind: 'inferred_pattern', text: 'x', evidenceEventIds: ['ev-1', 'ev-99'] },
      { slug: 'all-fake', kind: 'inferred_pattern', text: 'y', evidenceEventIds: ['ev-98', 'ev-99'] },
    ],
  }, valid)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].slug, 'half-real')
  assert.deepEqual(parsed[0].evidenceEventIds, ['ev-1'])
})

test('recommendations must cite a pattern slug from the same batch', () => {
  const parsed = parseInferences({
    inferences: [
      { slug: 'bottleneck', kind: 'inferred_pattern', text: 'p', evidenceEventIds: ['ev-1'] },
      { slug: 'add-check', kind: 'recommendation', text: 'r', basedOnSlugs: ['bottleneck'] },
      { slug: 'floating-rec', kind: 'recommendation', text: 'r2', basedOnSlugs: ['nonexistent'] },
    ],
  }, valid)
  assert.deepEqual(parsed.map((inference) => inference.slug).sort(), ['add-check', 'bottleneck'])
})

test('malformed payloads parse to empty, never throw', () => {
  assert.deepEqual(parseInferences(null, valid), [])
  assert.deepEqual(parseInferences({ inferences: 'nope' }, valid), [])
  assert.deepEqual(parseInferences({ inferences: [{ slug: 42 }] }, valid), [])
})

test('parses the raw JSON string returned by generateStructured', () => {
  const parsed = parseInferences(JSON.stringify({
    inferences: [{ slug: 'real', kind: 'inferred_pattern', text: 'Observed.', evidenceEventIds: ['ev-1'] }],
  }), valid)
  assert.equal(parsed[0]?.slug, 'real')
})
