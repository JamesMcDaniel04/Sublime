import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDLING_TIME_MINUTES,
  HANDLING_TIME_TABLE_VERSION,
  resolveHandlingMinutes,
} from '../handling-time'

test('curated table covers every action the adapters emit', () => {
  // Kept in sync by hand with the normalizers in src/lib/activity/sources/.
  // An action with no entry yields no cost estimate at all, so a gap here is
  // silently missing ROI rather than a visible error.
  const emitted = [
    'created_deal',
    'deal_stage_changed',
    'logged_email',
    'logged_call',
    'completed_task',
    'opened_pr',
    'opened_issue',
    'pushed_commit',
    'merged_pr',
    'closed_pr',
    'posted_message',
    'replied_in_thread',
    'held_meeting',
    'took_meeting_notes',
  ]
  for (const action of emitted) {
    assert.equal(typeof HANDLING_TIME_MINUTES[action], 'number', `missing handling time for ${action}`)
    assert.ok(HANDLING_TIME_MINUTES[action] > 0, `${action} must be positive`)
  }
})

test('unknown actions resolve to null rather than a guess', () => {
  assert.equal(resolveHandlingMinutes('invented_action', {}), null)
})

test('org overrides win over the curated default', () => {
  const settings = { handlingTimeOverrides: { logged_email: 9 } }
  assert.equal(resolveHandlingMinutes('logged_email', settings), 9)
  // Untouched actions keep the curated value.
  assert.equal(resolveHandlingMinutes('logged_call', settings), HANDLING_TIME_MINUTES.logged_call)
})

test('invalid overrides are ignored, not trusted', () => {
  for (const bad of [{ logged_email: 0 }, { logged_email: -3 }, { logged_email: '9' }, { logged_email: 100_000 }]) {
    assert.equal(
      resolveHandlingMinutes('logged_email', { handlingTimeOverrides: bad }),
      HANDLING_TIME_MINUTES.logged_email,
    )
  }
  assert.equal(
    resolveHandlingMinutes('logged_email', { handlingTimeOverrides: 'nope' }),
    HANDLING_TIME_MINUTES.logged_email,
  )
  assert.equal(resolveHandlingMinutes('logged_email', null), HANDLING_TIME_MINUTES.logged_email)
  // An array is an object to typeof; it must not be read as an override map.
  assert.equal(
    resolveHandlingMinutes('logged_email', { handlingTimeOverrides: [['logged_email', 9]] }),
    HANDLING_TIME_MINUTES.logged_email,
  )
})

test('the table is frozen so a caller cannot mutate shared defaults', () => {
  assert.throws(() => {
    ;(HANDLING_TIME_MINUTES as Record<string, number>).logged_email = 999
  })
})

test('table version is a positive integer', () => {
  assert.ok(Number.isInteger(HANDLING_TIME_TABLE_VERSION) && HANDLING_TIME_TABLE_VERSION > 0)
})
