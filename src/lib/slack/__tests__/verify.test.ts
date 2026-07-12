import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { computeSlackSignature, verifySlackSignature, SLACK_SIGNATURE_WINDOW_SECONDS } from '@/lib/slack/verify'

// Known vector, computed here from first principles so the helper can never
// drift from Slack's spec: v0=HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}").
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const TIMESTAMP = '1752300000'
const RAW_BODY = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather&text=94070'
const EXPECTED =
  'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${TIMESTAMP}:${RAW_BODY}`, 'utf8').digest('hex')

test('computeSlackSignature matches the hand-computed HMAC vector', () => {
  assert.equal(computeSlackSignature(SECRET, TIMESTAMP, RAW_BODY), EXPECTED)
})

test('verifySlackSignature accepts a valid signature inside the window', () => {
  const ok = verifySlackSignature({
    rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED,
    signingSecret: SECRET, nowMs: Number(TIMESTAMP) * 1000 + 60_000,
  })
  assert.equal(ok, true)
})

test('rejects a stale timestamp (> 300s skew, both directions)', () => {
  const base = { rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: SECRET }
  assert.equal(verifySlackSignature({ ...base, nowMs: (Number(TIMESTAMP) + SLACK_SIGNATURE_WINDOW_SECONDS + 1) * 1000 }), false)
  assert.equal(verifySlackSignature({ ...base, nowMs: (Number(TIMESTAMP) - SLACK_SIGNATURE_WINDOW_SECONDS - 1) * 1000 }), false)
})

test('rejects a tampered body, wrong secret, missing/garbled headers', () => {
  const nowMs = Number(TIMESTAMP) * 1000
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY + 'x', timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: 'wrong', nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: null, signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: null, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: 'not-a-number', signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  // Length mismatch must return false, not throw (timingSafeEqual throws on length mismatch).
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: 'v0=short', signingSecret: SECRET, nowMs }), false)
})
