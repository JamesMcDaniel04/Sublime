import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionGrantsAccess } from '../subscription-status'

const PAID = new Date('2026-01-01T00:00:00.000Z')

test('a trialing subscription grants access — the card is already on file', () => {
  assert.equal(subscriptionGrantsAccess('trialing', null), true)
})

test('an active subscription grants access', () => {
  assert.equal(subscriptionGrantsAccess('active', PAID), true)
})

test('past_due keeps access for a workspace that has paid before', () => {
  assert.equal(subscriptionGrantsAccess('past_due', PAID), true)
})

test('past_due revokes access when the trial-ending charge was the first ever', () => {
  assert.equal(subscriptionGrantsAccess('past_due', null), false)
})

test('terminal statuses never grant access', () => {
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(subscriptionGrantsAccess(status, PAID), false, `${status} should not grant access`)
  }
})
