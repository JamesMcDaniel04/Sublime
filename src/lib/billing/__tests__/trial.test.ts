import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@prisma/client'
import { billingStateFor, trialDaysRemaining } from '../trial'

test('paid plans are never trial-gated, even past an old trial deadline', () => {
  const billing = billingStateFor({
    plan: Plan.PROFESSIONAL,
    trialEndsAt: new Date(0),
    createdAt: new Date(0),
  })
  assert.equal(billing.state, 'paid')
})

test('a new unpaid workspace requires payment immediately', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  })
  assert.equal(billing.state, 'payment_required')
})

test('legacy trial dates never grant product access', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: new Date(Date.now() - 1000),
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
  })
  assert.equal(billing.state, 'payment_required')
})

test('workspaces that existed at paid launch stay unrestricted if the row backfill was missed', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: null,
    createdAt: new Date('2026-07-19T20:30:59.000Z'),
  })
  assert.equal(billing.state, 'paid')
  assert.equal(billing.plan, Plan.ENTERPRISE)
})

test('grandfathered test accounts remain paid and unrestricted without a subscription', () => {
  const billing = billingStateFor({
    plan: Plan.TRIAL,
    trialEndsAt: null,
    createdAt: new Date(),
    grandfatheredAt: new Date(),
  })
  assert.equal(billing.state, 'paid')
  assert.equal(billing.plan, Plan.ENTERPRISE)
})

const NOW = new Date('2026-07-28T12:00:00.000Z')
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000)

test('no trial end date means the workspace is not trialing', () => {
  assert.equal(trialDaysRemaining(null, NOW), null)
  assert.equal(trialDaysRemaining(undefined, NOW), null)
})

test('a fresh 14-day trial reads as 14 days', () => {
  assert.equal(trialDaysRemaining(daysFromNow(14), NOW), 14)
})

test('a partial day rounds up so the last hours never read as zero', () => {
  assert.equal(trialDaysRemaining(new Date(NOW.getTime() + 6 * 60 * 60 * 1000), NOW), 1)
})

test('an elapsed trial clamps to zero rather than going negative', () => {
  assert.equal(trialDaysRemaining(daysFromNow(-3), NOW), 0)
  assert.equal(trialDaysRemaining(NOW, NOW), 0)
})
