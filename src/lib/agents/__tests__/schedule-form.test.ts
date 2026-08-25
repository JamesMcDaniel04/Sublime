import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cadenceOf,
  cronToTime,
  daysFromCron,
  dowCron,
  normalizeSchedule,
  type ScheduleDraft,
} from '../schedule-form'

const draft = (schedule: Partial<ScheduleDraft>): ScheduleDraft => ({
  type: 'manual',
  timezone: 'UTC',
  isActive: false,
  ...schedule,
})

/**
 * Schedule conversion decides WHEN an agent runs. Every function here was
 * previously a private helper inside a 1,673-line form component, unreachable
 * by any test — so an off-by-one in the day-of-week list or a silent fallback
 * would have shipped as "the agent runs on the wrong day", with nothing to
 * catch it. Promoted to a module for the same reason goalReadWhere was.
 */

// ── dowCron / daysFromCron round trip ───────────────────────────────────

test('dowCron emits a five-field cron with the selected days, sorted', () => {
  assert.equal(dowCron('14:30', [5, 1, 3]), '30 14 * * 1,3,5')
})

test('day selections survive a round trip through cron', () => {
  for (const days of [[1], [0, 6], [1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6]]) {
    assert.deepEqual(daysFromCron(dowCron('09:00', days)), days, `days ${days.join(',')}`)
  }
})

test('an empty day selection falls back to a single day rather than every day', () => {
  // Emitting no day field would silently widen the schedule to daily, which is
  // the dangerous direction — an agent running 7x the intended frequency.
  assert.equal(dowCron('09:00', []), '0 9 * * 1')
})

test('a malformed time falls back to 09:00 instead of emitting NaN', () => {
  assert.equal(dowCron('', [1]), '0 9 * * 1')
  assert.equal(dowCron('not-a-time', [1]), '0 9 * * 1')
})

test('out-of-range hours and minutes never reach the cron string', () => {
  // Same invariant as the fallback above: whatever comes in, what goes out
  // must be a VALID cron. An out-of-range field does not error on save — the
  // schedule just never matches, so the agent quietly stops running.
  // Fields are "<minute> <hour> * * <dow>" — 24:00 clamps the HOUR to 23 and
  // leaves the minute at 0, so the cron reads "0 23", not "23 0".
  assert.equal(dowCron('99:99', [1]), '59 23 * * 1')
  assert.equal(dowCron('24:00', [1]), '0 23 * * 1')
  assert.equal(dowCron('-5:-5', [1]), '0 0 * * 1')
})

test('daysFromCron defaults to weekdays when the field is missing', () => {
  assert.deepEqual(daysFromCron(undefined), [1, 2, 3, 4, 5])
  assert.deepEqual(daysFromCron(''), [1, 2, 3, 4, 5])
  assert.deepEqual(daysFromCron('0 9 * *'), [1, 2, 3, 4, 5])
})

test('daysFromCron discards out-of-range days rather than scheduling them', () => {
  // 7 is a legal Sunday in some cron dialects but not in this 0-6 UI, and a
  // day the picker cannot represent must not survive into the form state.
  assert.deepEqual(daysFromCron('0 9 * * 7'), [1, 2, 3, 4, 5])
  assert.deepEqual(daysFromCron('0 9 * * 1,9,3'), [1, 3])
  assert.deepEqual(daysFromCron('0 9 * * abc'), [1, 2, 3, 4, 5])
})

// ── cronToTime ──────────────────────────────────────────────────────────

test('cronToTime zero-pads back into a time input value', () => {
  assert.equal(cronToTime('5 9 * * *'), '09:05')
  assert.equal(cronToTime('0 0 * * *'), '00:00')
  assert.equal(cronToTime('59 23 * * *'), '23:59')
})

test('cronToTime falls back to 09:00 on anything unparseable', () => {
  for (const bad of ['', '   ', 'not a cron', '* * * * *']) {
    assert.equal(cronToTime(bad), '09:00', `input ${JSON.stringify(bad)}`)
  }
})

// ── cadenceOf ───────────────────────────────────────────────────────────

test('cadenceOf maps each native schedule type to its own cadence', () => {
  assert.equal(cadenceOf(draft({ type: 'once' })), 'once')
  assert.equal(cadenceOf(draft({ type: 'hourly' })), 'hourly')
  assert.equal(cadenceOf(draft({ type: 'daily' })), 'daily')
  assert.equal(cadenceOf(draft({ type: 'weekly' })), 'weekly')
})

test('a day-of-week cron is recognised as the days-of-week cadence', () => {
  assert.equal(cadenceOf(draft({ type: 'cron', cron: '30 14 * * 1,3,5' })), 'daysofweek')
  assert.equal(cadenceOf(draft({ type: 'cron', cron: '0 9 * * 0' })), 'daysofweek')
})

test('a cron the picker cannot represent stays custom', () => {
  // Misclassifying these as daysofweek would let the UI silently rewrite an
  // expression the user hand-authored.
  for (const cron of [
    '*/5 * * * *',       // step values
    '0 9 1 * *',         // day-of-month
    '0 9 * 3 1',         // month restriction
    '0 9 * * 1-5',       // ranges
    '0 9 * * *',         // every day
    '0 9 * * 7',         // out-of-range day
    'garbage',
  ]) {
    assert.equal(cadenceOf(draft({ type: 'cron', cron })), 'custom', `cron ${cron}`)
  }
})

test('an unknown schedule type degrades to daily rather than throwing', () => {
  assert.equal(cadenceOf(draft({ type: 'nonsense' as never })), 'daily')
})

// ── normalizeSchedule ───────────────────────────────────────────────────

test('normalizeSchedule keeps a known type and fills the blanks', () => {
  assert.deepEqual(
    normalizeSchedule({ type: 'daily', timezone: '  ', isActive: true }),
    { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true },
  )
})

test('an unknown type carrying a cron becomes a cron schedule, not manual', () => {
  const result = normalizeSchedule({ type: 'bogus' as never, cron: '15 6 * * 1', timezone: 'UTC', isActive: true })
  assert.equal(result.type, 'cron')
  assert.equal(result.time, '06:15', 'the time input is recovered from the cron')
})

test('an unknown type with no cron becomes manual', () => {
  assert.equal(normalizeSchedule({ type: 'bogus' as never, timezone: 'UTC', isActive: false }).type, 'manual')
})

test('isActive is coerced to a real boolean', () => {
  // The form binds this to a switch; a truthy-but-not-true value reaching the
  // API would be rejected by zod at the boundary.
  assert.equal(normalizeSchedule({ type: 'daily', timezone: 'UTC', isActive: 1 as never }).isActive, true)
  assert.equal(normalizeSchedule({ type: 'daily', timezone: 'UTC', isActive: undefined as never }).isActive, false)
})

test('normalizeSchedule preserves fields it does not own', () => {
  const result = normalizeSchedule({
    type: 'once', time: '07:30', timezone: 'Europe/London', runAt: '2026-09-01', isActive: true,
  })
  assert.equal(result.runAt, '2026-09-01')
  assert.equal(result.timezone, 'Europe/London')
  assert.equal(result.time, '07:30')
})

test('normalizeSchedule is idempotent', () => {
  const once = normalizeSchedule({ type: 'bogus' as never, cron: '15 6 * * 1', timezone: '', isActive: true })
  assert.deepEqual(normalizeSchedule(once), once)
})
