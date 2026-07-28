import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldProposeCadenceChange } from '../cadence-proposal'

test('high skips with no derivable rule proposes a cadence change', () => {
  // Nothing explains the skips, so the honest read is volume, not targeting.
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 15, candidates: 0 }), true)
})

test('high skips WITH a derivable rule proposes nothing', () => {
  // A rule is the better remedy; proposing both would ask the user to fix a
  // problem the agent is already about to fix itself.
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 15, candidates: 1 }), false)
})

test('a healthy skip rate proposes nothing', () => {
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 4, candidates: 0 }), false)
})

test('too little work to judge proposes nothing', () => {
  // 6 of 9 skipped is 0.67, over the rate — but nine items is not a pattern.
  assert.equal(shouldProposeCadenceChange({ produced: 9, skipped: 6, candidates: 0 }), false)
})

test('exactly at both thresholds proposes', () => {
  assert.equal(shouldProposeCadenceChange({ produced: 10, skipped: 6, candidates: 0 }), true)
})

test('no work at all proposes nothing and does not divide by zero', () => {
  assert.equal(shouldProposeCadenceChange({ produced: 0, skipped: 0, candidates: 0 }), false)
})
