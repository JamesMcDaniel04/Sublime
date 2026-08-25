/**
 * `{{now}}` and `{{today}}` — the most-used n8n expression, absent here.
 *
 * Dates currently require a `{{js:}}` escape or a whole code step. n8n's
 * `$now`/`$today` are the single most-reached-for expression in its docs.
 *
 * Two design decisions these tests pin:
 *
 * 1. `{{now}}` is the moment the RUN STARTED, not the wall clock at each read.
 *    n8n's `$now` is "this instant", which means two tokens in one flow can
 *    disagree and a retry writes different values than the original attempt.
 *    These values end up in filenames, output records and idempotency keys,
 *    where stability across a retry is worth more than sub-second accuracy.
 *
 * 2. Everything renders in the FLOW'S timezone, defaulting to UTC — never the
 *    server's. A date rendered in server time is the same class of bug as a
 *    schedule that fires in server time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockToken, CLOCK_ROOTS } from '../clock-tokens'

// 2026-03-14T15:09:26.535Z — a Saturday, and 14 March in UTC but already the
// 15th in Tokyo, which is what makes the timezone cases meaningful.
const AT = '2026-03-14T15:09:26.535Z'

const now = (path: string, timezone?: string) => clockToken(path, { startedAt: AT, timezone })

test('{{now}} is a full ISO instant', () => {
  assert.equal(now('now'), '2026-03-14T15:09:26.535Z')
})

test('{{today}} is a plain calendar date', () => {
  assert.equal(now('today'), '2026-03-14')
})

test('date parts read off the same instant', () => {
  assert.equal(now('now.date'), '2026-03-14')
  assert.equal(now('now.time'), '15:09:26')
  assert.equal(now('now.year'), 2026)
  assert.equal(now('now.month'), 3)
  assert.equal(now('now.day'), 14)
})

test('epoch is a number, for arithmetic in a js token', () => {
  assert.equal(now('now.epoch'), Date.parse(AT))
})

// The reason timezone support is not optional.
test('the calendar date follows the flow timezone, not the server', () => {
  // 15:09 UTC is already the next day in Tokyo.
  assert.equal(now('today', 'Asia/Tokyo'), '2026-03-15')
  assert.equal(now('today', 'UTC'), '2026-03-14')
  // …and the previous evening in Los Angeles.
  assert.equal(now('today', 'America/Los_Angeles'), '2026-03-14')
  assert.equal(now('now.hour', 'America/Los_Angeles'), 8)
  assert.equal(now('now.hour', 'Asia/Tokyo'), 0)
})

test('an absent timezone means UTC, never the server default', () => {
  assert.equal(now('now.date'), now('now.date', 'UTC'))
})

test('weekday is the ISO day number in the flow timezone', () => {
  assert.equal(now('now.weekday', 'UTC'), 6, '2026-03-14 is a Saturday')
  assert.equal(now('now.weekday', 'Asia/Tokyo'), 7, 'already Sunday in Tokyo')
})

// Stability is the whole point of pinning to run start.
test('every read in one run returns the same instant', () => {
  const ctx = { startedAt: AT, timezone: 'UTC' }
  assert.equal(clockToken('now', ctx), clockToken('now', ctx))
})

// An unknown part must not resolve to something plausible-looking.
test('an unknown part is undefined rather than a wrong value', () => {
  assert.equal(now('now.fortnight'), undefined)
  assert.equal(now('today.nonsense'), undefined)
})

test('a bad timezone falls back to UTC instead of throwing', () => {
  assert.equal(now('today', 'Not/AZone'), '2026-03-14')
})

// The resolver needs to know which roots it owns without importing the impl.
test('CLOCK_ROOTS names exactly the roots this module handles', () => {
  assert.deepEqual([...CLOCK_ROOTS].sort(), ['now', 'today'])
})

test('a non-clock path is not claimed', () => {
  assert.equal(clockToken('trigger.input', { startedAt: AT }), undefined)
})
