import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatGoalDigest, shouldRunWeeklyGoalDigest } from '../digest'

test('digest formatter labels risk, pace, delta, runs, and settlements', () => {
  const output = formatGoalDigest([
    {
      name: 'Q3 quota',
      riskLevel: 'at_risk',
      currentValue: 80,
      expectedValue: 90,
      weekDelta: 5,
      attributedRuns: 3,
      settled: [{ outcome: 'achieved', periodEnd: new Date() }],
    },
  ])
  assert.match(output.text, /at risk/)
  assert.match(output.text, /80 vs 90 pace/)
  assert.match(output.text, /\+5 this week/)
  assert.match(output.text, /3 attributed runs/)
  assert.match(output.html, /<li>/)
})

test('weekly digest window is Monday 14:00 UTC only', () => {
  assert.equal(shouldRunWeeklyGoalDigest(new Date('2026-07-27T14:05:00Z')), true)
  assert.equal(shouldRunWeeklyGoalDigest(new Date('2026-07-27T14:15:00Z')), false)
  assert.equal(shouldRunWeeklyGoalDigest(new Date('2026-07-28T14:05:00Z')), false)
})
