import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trialParamsFor, TRIAL_DAYS } from '../plans'

test('a workspace that has never trialed gets the full free window', () => {
  const params = trialParamsFor(null)
  assert.equal(params.trial_period_days, TRIAL_DAYS)
  assert.equal(params.trial_period_days, 14)
})

test('a card-less trial is configured to cancel rather than grant free access', () => {
  const params = trialParamsFor(null)
  assert.deepEqual(params.trial_settings, { end_behavior: { missing_payment_method: 'cancel' } })
})

test('a workspace that already trialed is charged from day one', () => {
  // The cancel-on-day-13-and-resubscribe loop: no trial keys at all, so the
  // spread contributes nothing and Stripe bills immediately.
  assert.deepEqual(trialParamsFor(new Date('2026-01-01T00:00:00.000Z')), {})
})

test('an undefined trial start is treated as never-trialed, not as spent', () => {
  // Guards against a narrowed Prisma select dropping the column and silently
  // turning the trial off for everyone.
  assert.equal(trialParamsFor(undefined).trial_period_days, TRIAL_DAYS)
})
