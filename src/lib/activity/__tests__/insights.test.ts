import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferenceGraphParts } from '@/lib/activity/insights'

test('inferred_pattern carries one evidence edge per cited event', () => {
  const { nodes, edges } = inferenceGraphParts({
    organizationId: 'org-1', kind: 'inferred_pattern', slug: 'legal-review-bottleneck',
    text: 'Legal review appears to be a recurring bottleneck.',
    evidenceEventIds: ['ev-1', 'ev-2', 'ev-3'],
  })
  assert.equal(nodes[0].id, 'insight:activity:inferred_pattern:legal-review-bottleneck')
  assert.equal(nodes[0].props.insightKind, 'inferred_pattern')
  const evidence = edges.filter((edge) => edge.rel === 'evidence')
  assert.deepEqual(evidence.map((edge) => edge.to).sort(), ['activity:ev-1', 'activity:ev-2', 'activity:ev-3'])
})

test('REJECTS a pattern with zero evidence — the spec §8 invariant', () => {
  assert.throws(
    () => inferenceGraphParts({ organizationId: 'org-1', kind: 'inferred_pattern', slug: 'x', text: 'vibes', evidenceEventIds: [] }),
    /inference rejected: no evidence/,
  )
})

test('recommendation cites patterns via based_on, not raw facts', () => {
  const { edges } = inferenceGraphParts({
    organizationId: 'org-1', kind: 'recommendation', slug: 'legal-readiness-check',
    text: 'Add a legal-readiness check before proposal stage.',
    evidenceEventIds: [],
    basedOnInsightIds: ['insight:activity:inferred_pattern:legal-review-bottleneck'],
  })
  assert.equal(edges.length, 1)
  assert.equal(edges[0].rel, 'based_on')
  assert.equal(edges[0].to, 'insight:activity:inferred_pattern:legal-review-bottleneck')
})

test('REJECTS a recommendation with no based_on patterns', () => {
  assert.throws(
    () => inferenceGraphParts({ organizationId: 'org-1', kind: 'recommendation', slug: 'x', text: 'do stuff', evidenceEventIds: [] }),
    /inference rejected: no evidence/,
  )
})
