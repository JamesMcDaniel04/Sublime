import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSchedule } from '../describe-schedule'

/** Fixed reference instants so DST is pinned rather than ambient. */
const JULY = new Date('2026-07-15T00:00:00Z')
const JANUARY = new Date('2026-01-15T00:00:00Z')

const cron = (expression: string) => ({ type: 'cron', cron: expression, timezone: 'UTC' })

test('daily cron converts to the viewer 12-hour local time', () => {
  assert.equal(
    describeSchedule(cron('0 7 * * *'), 'America/Denver', JULY),
    'Every day at 1:00 AM MDT',
  )
})

test('the same cron reads differently across a DST boundary', () => {
  assert.equal(
    describeSchedule(cron('0 7 * * *'), 'America/Denver', JANUARY),
    'Every day at 12:00 AM MST',
  )
})

test('a weekly cron shifts the weekday backwards when the local time crosses midnight', () => {
  // Monday 01:00 UTC is Sunday 19:00 in Denver.
  assert.equal(
    describeSchedule(cron('0 1 * * 1'), 'America/Denver', JULY),
    'Every Sunday at 7:00 PM MDT',
  )
})

test('a weekday range keeps its weekday when no midnight is crossed', () => {
  assert.equal(
    describeSchedule(cron('0 16 * * 1-5'), 'America/Denver', JULY),
    'Weekdays at 10:00 AM MDT',
  )
})

test('an eastward viewer keeps the same weekday', () => {
  const label = describeSchedule(cron('0 13 * * 1'), 'Asia/Tokyo', JULY)
  assert.match(label, /^Every Monday at 10:00 PM/)
})

test('a two-day cron lists both days', () => {
  assert.equal(
    describeSchedule(cron('0 16 * * 2,4'), 'UTC', JULY),
    'Every Tuesday and Thursday at 4:00 PM UTC',
  )
})

test('an unparseable cron never prints the expression', () => {
  const label = describeSchedule(cron('*/15 * * * *'), 'America/Denver', JULY)
  assert.equal(label, 'On a custom schedule')
  assert.doesNotMatch(label, /\*/)
})

test('day-of-month crons fall back rather than misreporting', () => {
  assert.equal(describeSchedule(cron('0 9 1 * *'), 'UTC', JULY), 'On a custom schedule')
})

test('non-cron schedule types render without any cron vocabulary', () => {
  assert.equal(describeSchedule({ type: 'manual' }, 'UTC', JULY), 'Runs manually')
  assert.equal(describeSchedule({ type: 'hourly' }, 'UTC', JULY), 'Every hour')
  assert.equal(
    describeSchedule({ type: 'daily', time: '09:00', timezone: 'UTC' }, 'America/Denver', JULY),
    'Every day at 3:00 AM MDT',
  )
})

test('an inactive schedule is marked paused', () => {
  assert.equal(
    describeSchedule({ ...cron('0 7 * * *'), isActive: false }, 'America/Denver', JULY),
    'Every day at 1:00 AM MDT (paused)',
  )
})
