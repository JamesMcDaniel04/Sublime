import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPatternEligible, MIN_OCCURRENCES, MIN_SPAN_DAYS, LEARNING_PERIOD_DAYS } from '@/lib/behavior/eligibility'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-07-17T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * day)
const good = { occurrenceCount: 3, firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(1), status: 'open' }
const learnedUser = daysAgo(30) // first event 30 days ago — past learning period

test('constants are the spec values', () => {
  assert.equal(MIN_OCCURRENCES, 3)
  assert.equal(MIN_SPAN_DAYS, 7)
  assert.equal(LEARNING_PERIOD_DAYS, 7)
})

test('a 3x/10-day open pattern for a learned user is eligible', () => {
  assert.equal(isPatternEligible(good, learnedUser, now), true)
})

test('below occurrence threshold is ineligible', () => {
  assert.equal(isPatternEligible({ ...good, occurrenceCount: 2 }, learnedUser, now), false)
})

test('a burst (span < 7 days) is ineligible — one busy day is not a routine', () => {
  assert.equal(isPatternEligible({ ...good, firstSeenAt: daysAgo(2) }, learnedUser, now), false)
})

test('user inside the 7-day learning period gets NOTHING, even a strong pattern', () => {
  assert.equal(isPatternEligible(good, daysAgo(3), now), false)
})

test('unknown first-event date means still learning', () => {
  assert.equal(isPatternEligible(good, null, now), false)
})

test('dismissed patterns are never eligible', () => {
  assert.equal(isPatternEligible({ ...good, status: 'dismissed' }, learnedUser, now), false)
})

test('boundaries are inclusive: exactly 3 occurrences over exactly 7 days, learning period exactly over', () => {
  const boundary = { occurrenceCount: 3, firstSeenAt: daysAgo(7), lastSeenAt: now, status: 'open' }
  assert.equal(isPatternEligible(boundary, daysAgo(7), now), true)
})
