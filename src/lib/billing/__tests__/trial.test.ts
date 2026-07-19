import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@prisma/client'
import { billingStateFor } from '../trial'

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
