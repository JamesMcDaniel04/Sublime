import test from 'node:test'
import assert from 'node:assert/strict'
import { renderWorkFeedback } from '../work-feedback'

const stats = { produced: 18, used: 14, worked: 6, usedRate: 14 / 18, workedRate: 6 / 14 }
const empty = { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null }

const rule = {
  id: 'rul_8f2',
  statement: 'Do not work subjects whose daysCold is under 14.',
  skippedCount: 6,
  totalCount: 7,
  topSkipReason: 'too_early',
  exploreRate: 0.2,
}

test('with no work at all it renders nothing', () => {
  // A block that says "0 produced" on a brand-new goal is noise, not feedback.
  assert.equal(
    renderWorkFeedback({ goalName: 'Revive stalled deals', stats: empty, skipReasons: [], rules: [] }),
    '',
  )
})

test('stats alone render without a rules section', () => {
  const block = renderWorkFeedback({
    goalName: 'Revive stalled deals',
    stats,
    skipReasons: [
      { reason: 'too_early', count: 3 },
      { reason: 'wrong_contact', count: 1 },
    ],
    rules: [],
  })
  assert.match(block, /^## What your work has taught us/)
  assert.match(block, /18 produced/)
  assert.match(block, /14 used/)
  assert.match(block, /6 worked/)
  assert.match(block, /too early ×3/)
  assert.equal(/Rules you must follow/.test(block), false)
})

test('rules render with their evidence and a probe instruction carrying the real id', () => {
  const block = renderWorkFeedback({
    goalName: 'Revive stalled deals',
    stats,
    skipReasons: [{ reason: 'too_early', count: 3 }],
    rules: [rule],
  })
  assert.match(block, /Rules you must follow/)
  assert.match(block, /Do not work subjects whose daysCold is under 14\./)
  assert.match(block, /6 of 7 skipped/)
  assert.match(block, /too early/)
  // The probe instruction is the whole falsification mechanism — without the
  // real rule id the agent cannot label a probe and the rule can never die.
  assert.match(block, /probeRuleId "rul_8f2"/)
  assert.match(block, /1 in 5/)
})

test('the explore rate is rendered as a ratio the agent can act on', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [],
    rules: [{ ...rule, exploreRate: 0.25 }],
  })
  assert.match(block, /1 in 4/)
})

test('skip reasons render as human words, never raw enum values', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [{ reason: 'already_handled', count: 2 }],
    rules: [],
  })
  assert.match(block, /already handled ×2/)
  assert.equal(/already_handled/.test(block), false)
})

test('it never claims the work caused anything', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [{ reason: 'too_early', count: 3 }],
    rules: [rule],
  })
  assert.equal(/caused/i.test(block), false)
})

test('rules render even when the stats window is empty', () => {
  // A rule learned from 90 days of evidence outlives a quiet 30-day window.
  const block = renderWorkFeedback({ goalName: 'G', stats: empty, skipReasons: [], rules: [rule] })
  assert.match(block, /Rules you must follow/)
  assert.equal(/0 produced/.test(block), false, 'a dead stats line must be omitted')
})

test('a rule with no recorded skip reason still renders its evidence', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [],
    rules: [{ ...rule, topSkipReason: null }],
  })
  assert.match(block, /\(6 of 7 skipped\)/)
})
