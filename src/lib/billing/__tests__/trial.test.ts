import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@prisma/client'
import { billingStateFor, newTrialEnd, trialEndFor, TRIAL_DAYS } from '../trial'

const DAY_MS = 24 * 60 * 60 * 1000

test('paid plans are never trial-gated, even past an old trial deadline', () => {
  const billing = billingStateFor({
    plan: Plan.PROFESSIONAL,
    trialEndsAt: new Date(Date.now() - 30 * DAY_MS),
    createdAt: new Date(Date.now() - 60 * DAY_MS),
  })
  assert.equal(billing.state, 'paid')
})

test('a fresh TRIAL org is trialing with the full 14 days', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: newTrialEnd(),
    createdAt: new Date(),
  })
  assert.equal(billing.state, 'trialing')
  assert.equal(billing.state === 'trialing' && billing.daysLeft, TRIAL_DAYS)
})

test('a TRIAL org past its deadline is expired', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: new Date(Date.now() - 1000),
    createdAt: new Date(Date.now() - 15 * DAY_MS),
  })
  assert.equal(billing.state, 'expired')
})

test('pre-migration orgs (null trialEndsAt) fall back to signup + 14 days', () => {
  // Regression guard: a null column must never mean "trial forever" nor
  // "instant lockout" — it derives the same deadline new signups get.
  const youngOrg = { plan: Plan.TRIAL, trialEndsAt: null, createdAt: new Date(Date.now() - 2 * DAY_MS) }
  const oldOrg = { plan: Plan.TRIAL, trialEndsAt: null, createdAt: new Date(Date.now() - 20 * DAY_MS) }
  assert.equal(billingStateFor(youngOrg).state, 'trialing')
  assert.equal(billingStateFor(oldOrg).state, 'expired')
  assert.equal(trialEndFor(youngOrg).getTime(), youngOrg.createdAt.getTime() + TRIAL_DAYS * DAY_MS)
})

test('daysLeft rounds up so day 13.5 still reads "1 day left", never 0', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: new Date(Date.now() + DAY_MS / 2),
    createdAt: new Date(),
  })
  assert.equal(billing.state === 'trialing' && billing.daysLeft, 1)
})
