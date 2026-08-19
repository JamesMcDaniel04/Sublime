import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mfaStepUpRequired } from '../mfa'

const enrolled = new Date('2026-01-01T00:00:00Z')

test('an enrolled account at aal1 must step up', () => {
  assert.equal(mfaStepUpRequired('aal1', enrolled, false), true)
})

test('an enrolled account already at aal2 is satisfied', () => {
  assert.equal(mfaStepUpRequired('aal2', enrolled, false), false)
})

test('a non-enrolled account is never blocked (no lockout for members)', () => {
  assert.equal(mfaStepUpRequired('aal1', null, false), false)
  assert.equal(mfaStepUpRequired(undefined, null, false), false)
})

test('an unknown/absent aal does not block an enrolled admin (fallback safety)', () => {
  assert.equal(mfaStepUpRequired(undefined, enrolled, false), false)
})

test('the operator bypass lifts enforcement entirely', () => {
  assert.equal(mfaStepUpRequired('aal1', enrolled, true), false)
})
