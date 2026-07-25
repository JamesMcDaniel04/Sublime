/**
 * Verification state derivation. The invariant that gives this feature its
 * value: NOT-YET-CHECKED must never read as healthy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFY_STALE_MS,
  credentialVerificationKey,
  toVerification,
  verificationLabel,
  verificationState,
} from '../verification'

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0)
const ago = (ms: number) => new Date(NOW - ms)

test('a missing row is unverified, never verified', () => {
  // The whole point: absence of proof is not proof.
  assert.equal(verificationState(null, NOW), 'unverified')
  assert.equal(verificationState(undefined, NOW), 'unverified')
})

test('a recent pass is verified', () => {
  assert.equal(verificationState({ state: 'verified', checkedAt: ago(60_000) }, NOW), 'verified')
})

test('a pass older than the stale window is stale', () => {
  assert.equal(verificationState({ state: 'verified', checkedAt: ago(VERIFY_STALE_MS + 1) }, NOW), 'stale')
})

test('the stale boundary is inclusive of exactly-the-window', () => {
  // At exactly the window it is still verified; one ms past, stale.
  assert.equal(verificationState({ state: 'verified', checkedAt: ago(VERIFY_STALE_MS) }, NOW), 'verified')
  assert.equal(verificationState({ state: 'verified', checkedAt: ago(VERIFY_STALE_MS + 1) }, NOW), 'stale')
})

test('a failure never decays to stale', () => {
  // "This broke" is more actionable than "this is old", so a known failure
  // stays a failure until something proves otherwise.
  assert.equal(verificationState({ state: 'failed', checkedAt: ago(VERIFY_STALE_MS * 10) }, NOW), 'failed')
})

test('an unrecognised stored state is unverified, not verified', () => {
  // Defensive: a future state value must fail closed.
  assert.equal(verificationState({ state: 'pending', checkedAt: ago(1) }, NOW), 'unverified')
})

test('toVerification carries the timestamp and failure reason', () => {
  const shape = toVerification({ state: 'failed', checkedAt: ago(1000), error: '401 Unauthorized' }, NOW)
  assert.equal(shape.state, 'failed')
  assert.equal(shape.error, '401 Unauthorized')
  assert.equal(shape.checkedAt, new Date(NOW - 1000).toISOString())
})

test('toVerification omits the timestamp when there is no row', () => {
  assert.deepEqual(toVerification(null, NOW), { state: 'unverified' })
})

test('a passing row carries no error even if one was stored', () => {
  const shape = toVerification({ state: 'verified', checkedAt: ago(1), error: 'stale reason' }, NOW)
  assert.equal(shape.error, undefined)
})

test('labels state a fact rather than hedging', () => {
  assert.equal(verificationLabel('verified'), 'Verified')
  assert.equal(verificationLabel('failed'), 'Not working')
  assert.equal(verificationLabel('stale'), 'Not checked recently')
  // Not "unknown": say what is missing.
  assert.equal(verificationLabel('unverified'), 'Never used successfully')
})

test('credential keys are namespaced so one table covers every plane', () => {
  assert.equal(credentialVerificationKey('abc'), 'credential:abc')
})
