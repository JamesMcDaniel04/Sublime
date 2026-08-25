import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baselineInferenceText, baselineSlug, projectBaseline } from '../project'
import type { ComputedBaseline } from '../types'

const baseline: ComputedBaseline = {
  source: 'hubspot',
  action: 'deal_stage_changed',
  entityType: 'deal',
  volume: 214,
  windowDays: 90,
  periodDays: 0.4,
  distinctActors: 6,
  medianCycleTimeHours: 264,
  reworkRate: 0.4,
  confidence: 1,
}

test('slug is stable and safe as a node id segment', () => {
  assert.equal(baselineSlug(baseline), 'hubspot-deal_stage_changed-deal')
})

test('inference text states the measured facts, not an interpretation', () => {
  const text = baselineInferenceText(baseline)
  assert.match(text, /214/)
  assert.match(text, /90 days/)
  assert.match(text, /6 people/)
  assert.match(text, /264/)
  assert.match(text, /40%/)
  // No recommendation language — this node is a fact, and the citation
  // invariant distinguishes facts from the recommendations built on them.
  assert.doesNotMatch(text, /should|recommend|consider/i)
})

test('unmeasurable fields are omitted rather than rendered as zero', () => {
  const text = baselineInferenceText({
    ...baseline,
    medianCycleTimeHours: null,
    reworkRate: null,
    periodDays: null,
  })
  assert.doesNotMatch(text, /cycle time/i)
  assert.doesNotMatch(text, /rework/i)
  assert.match(text, /214/)
})

test('a baseline with no evidence is never projected', async () => {
  // writeInference would reject it anyway; refusing here keeps the invariant
  // visible at the call site instead of relying on a downstream throw.
  assert.equal(await projectBaseline('org_1', baseline, []), false)
})
