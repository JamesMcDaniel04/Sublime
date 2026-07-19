import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  patternKindOfSlug,
  scoreOutcome,
  computeKindWeights,
  suggestionOutcomeLabel,
  KIND_SUPPRESS_WEIGHT,
} from '@/lib/behavior/outcome-weights'

test('patternKindOfSlug: every live slug prefix maps to its kind', () => {
  assert.equal(patternKindOfSlug('seq:a>>b'), 'sequence')
  assert.equal(patternKindOfSlug('routine:agent_run_manual:agent:a-1:1'), 'temporal')
  assert.equal(patternKindOfSlug('friction:agent:a-1'), 'friction')
  assert.equal(patternKindOfSlug('intent:e-1'), 'intent')
  assert.equal(patternKindOfSlug('toolcorr:asana+github'), 'tool_correlation')
  assert.equal(patternKindOfSlug('gap:dormant:slack'), 'capability_gap')
  assert.equal(patternKindOfSlug('peer:flow:f-1'), 'peer_practice')
  assert.equal(patternKindOfSlug('archetype:asana+slack:schedule'), 'archetype_gap')
  assert.equal(patternKindOfSlug('mystery:x'), null)
})

test('scoreOutcome: adoption is strongest positive, deletion strongest negative', () => {
  assert.equal(scoreOutcome('accepted-and-adopted'), 2)
  assert.equal(scoreOutcome('accepted'), 1)
  assert.equal(scoreOutcome('accepted-but-never-published'), -1)
  assert.equal(scoreOutcome('dismissed'), -1)
  assert.equal(scoreOutcome('accepted-then-deleted'), -2)
  assert.equal(scoreOutcome('open'), 0)
})

test('computeKindWeights: each suggestion contributes once per cited kind', () => {
  const weights = computeKindWeights([
    { sourcePatternSlugs: ['seq:a>>b', 'seq:c>>d'], outcome: 'accepted-and-adopted' }, // sequence +2 once
    { sourcePatternSlugs: ['toolcorr:x+y'], outcome: 'dismissed' },
    { sourcePatternSlugs: ['toolcorr:x+y', 'gap:dormant:z'], outcome: 'dismissed' },
    { sourcePatternSlugs: ['mystery:x'], outcome: 'dismissed' }, // unknown kind ignored
  ])
  assert.equal(weights.get('sequence'), 2)
  assert.equal(weights.get('tool_correlation'), -2)
  assert.equal(weights.get('capability_gap'), -1)
  assert.equal(weights.has('mystery'), false)
})

test('suppression threshold: two plain rejections cross it, one does not', () => {
  const one = computeKindWeights([{ sourcePatternSlugs: ['toolcorr:x+y'], outcome: 'dismissed' }])
  assert.ok((one.get('tool_correlation') ?? 0) > KIND_SUPPRESS_WEIGHT)
  const two = computeKindWeights([
    { sourcePatternSlugs: ['toolcorr:x+y'], outcome: 'dismissed' },
    { sourcePatternSlugs: ['toolcorr:x+z'], outcome: 'dismissed' },
  ])
  assert.ok((two.get('tool_correlation') ?? 0) <= KIND_SUPPRESS_WEIGHT)
})

test('suggestionOutcomeLabel still labels adoption states (moved module)', () => {
  const now = new Date('2026-07-18T12:00:00Z')
  const row = { title: 't', status: 'accepted', kind: 'new_flow', flowId: 'f-1', updatedAt: new Date('2026-06-01T00:00:00Z') }
  assert.equal(suggestionOutcomeLabel(row, { status: 'ACTIVE', publishedGraph: null }, now), 'accepted-and-adopted')
  assert.equal(suggestionOutcomeLabel(row, { status: 'DRAFT', publishedGraph: null }, now), 'accepted-but-never-published')
  assert.equal(suggestionOutcomeLabel(row, null, now), 'accepted-then-deleted')
  assert.equal(suggestionOutcomeLabel({ ...row, status: 'dismissed' }, null, now), 'dismissed')
})
