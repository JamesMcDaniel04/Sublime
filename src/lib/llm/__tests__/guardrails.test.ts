import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets, wrapUntrusted, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../guardrails'

test('redactSecrets masks well-known credential shapes', () => {
  const cases: Array<[string, string]> = [
    ['key sk-ant-api03-abcdefghijklmnop1234 here', 'api-key'],
    ['stripe sk_live_abcdefghijklmnop1234', 'api-key'],
    ['aws AKIAIOSFODNN7EXAMPLE id', 'aws-access-key'],
    ['slack xoxb-1234567890-abcdefghij token', 'slack-token'],
    ['gh ghp_abcdefghijklmnopqrstuvwxyz123456', 'github-token'],
    ['authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789', 'bearer-token'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', 'jwt'],
  ]
  for (const [input, label] of cases) {
    const out = redactSecrets(input)
    assert.ok(out.includes(`[redacted:${label}]`), `${label}: got "${out}"`)
  }
  const pem = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')
  assert.ok(pem.includes('[redacted:private-key]'))
  assert.ok(!pem.includes('MIIE'))
})

test('redactSecrets keeps the Bearer keyword so the model knows auth was present', () => {
  const out = redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz0123456789')
  assert.match(out, /^Bearer \[redacted:bearer-token\]$/)
})

test('redactSecrets leaves ordinary data alone', () => {
  const benign = [
    'Contact jane@acme.com about the Q3 renewal for $120,000',
    'record id rec_9f8e7d6c5b4a account 0015500000WVEqPAAX',
    'commit 4f2c1a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39',
    'short Bearer abc',
  ]
  for (const text of benign) {
    assert.equal(redactSecrets(text), text)
  }
})

test('redactSecrets survives JSON-serialized tool output', () => {
  const json = JSON.stringify({ headers: { authorization: 'Bearer tok_abcdefghijklmnopqrstuvwx' }, ok: true })
  const out = redactSecrets(json)
  assert.ok(!out.includes('tok_abcdefghijklmnopqrstuvwx'))
  assert.doesNotThrow(() => JSON.parse(out))
})

test('wrapUntrusted fences the block with markers and the data-not-instructions rule', () => {
  const wrapped = wrapUntrusted('## Correlated context\n- [account] Acme is churning')
  assert.ok(wrapped.startsWith(UNTRUSTED_OPEN))
  assert.ok(wrapped.endsWith(UNTRUSTED_CLOSE))
  assert.ok(wrapped.includes('not instructions') || wrapped.includes('reference material'))
  assert.ok(wrapped.includes('Acme is churning'))
  assert.equal(wrapUntrusted(''), '')
})
