import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { verifySignature, signPayload } from '../verify'

const SECRET = 'whsec_test'
const BODY = '{"type":"deal.risk_detected","id":"evt_1"}'

test('accepts a valid timestamped signature', () => {
  const now = 1_700_000_000_000
  const header = signPayload(BODY, SECRET, now)
  assert.equal(verifySignature({ rawBody: BODY, header, secret: SECRET, now: () => now }), true)
})

test('rejects a tampered body', () => {
  const now = 1_700_000_000_000
  const header = signPayload(BODY, SECRET, now)
  assert.equal(
    verifySignature({ rawBody: BODY.replace('risk', 'hype'), header, secret: SECRET, now: () => now }),
    false,
  )
})

test('rejects a wrong secret', () => {
  const now = 1_700_000_000_000
  const header = signPayload(BODY, SECRET, now)
  assert.equal(verifySignature({ rawBody: BODY, header, secret: 'other', now: () => now }), false)
})

test('rejects a stale timestamp (replay protection)', () => {
  const then = 1_700_000_000_000
  const header = signPayload(BODY, SECRET, then)
  const now = then + 10 * 60 * 1000 // 10 minutes later, default tolerance 5m
  assert.equal(verifySignature({ rawBody: BODY, header, secret: SECRET, now: () => now }), false)
})

test('accepts a plain hex hmac header (format seam fallback)', () => {
  const hex = crypto.createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex')
  assert.equal(verifySignature({ rawBody: BODY, header: hex, secret: SECRET }), true)
})

test('rejects missing header or secret', () => {
  assert.equal(verifySignature({ rawBody: BODY, header: null, secret: SECRET }), false)
  assert.equal(verifySignature({ rawBody: BODY, header: 'x', secret: '' }), false)
})
