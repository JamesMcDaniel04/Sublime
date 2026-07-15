/**
 * Redaction is the load-bearing safety property of the export subsystem: the
 * file leaves the platform and gets pasted into other products. These tests
 * cover every place a credential actually hides, not just Authorization headers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCredentialKey, redactDeep, redactUrl, REDACTED } from '../redact'

// ── URLs ────────────────────────────────────────────────────────────────────

test('strips basic-auth userinfo from a URL', () => {
  const out = redactUrl('https://alice:hunter2@api.example.com/v1/leads')
  assert.equal(out.includes('hunter2'), false)
  assert.equal(out.includes('alice'), false)
  assert.match(out, /api\.example\.com\/v1\/leads/, 'the endpoint itself survives')
})

test('redacts credential query params but keeps the rest of the URL usable', () => {
  const out = redactUrl('https://api.example.com/v1?api_key=SECRET&page=2&access_token=T0K3N')
  assert.equal(out.includes('SECRET'), false)
  assert.equal(out.includes('T0K3N'), false)
  assert.match(out, /page=2/, 'non-credential params are preserved')
  assert.match(out, /api_key=redacted/)
})

test('leaves a templated URL alone (no literal secret, and it will not parse)', () => {
  assert.equal(redactUrl('{{trigger.input.url}}/leads'), '{{trigger.input.url}}/leads')
  assert.equal(redactUrl(''), '')
})

// ── Nested values ───────────────────────────────────────────────────────────

test('redacts credential-named keys at any depth', () => {
  const out = redactDeep({ page: 2, auth: { client_secret: 'S', nested: { apiKey: 'K' } } }) as Record<string, any>
  assert.equal(out.page, 2, 'ordinary data is untouched')
  assert.equal(out.auth, REDACTED, 'a credential-named branch is redacted whole')
  const deep = redactDeep({ outer: { refresh_token: 'R', keep: 'me' } }) as Record<string, any>
  assert.equal(deep.outer.refresh_token, REDACTED)
  assert.equal(deep.outer.keep, 'me')
})

test('redacts inside a JSON *string* — how the builder actually stores these fields', () => {
  const out = redactDeep('{"api_key":"SECRET","q":"leads"}') as string
  assert.equal(out.includes('SECRET'), false)
  assert.match(out, /leads/, 'the real payload survives')
})

test('a non-JSON string is left exactly as-is', () => {
  assert.equal(redactDeep('just some text'), 'just some text')
  assert.equal(redactDeep('{not json'), '{not json')
})

test('arrays are walked', () => {
  const out = redactDeep([{ token: 'A' }, { name: 'B' }]) as any[]
  assert.equal(out[0].token, REDACTED)
  assert.equal(out[1].name, 'B')
})

// ── The name rule ───────────────────────────────────────────────────────────

test('recognises the credential names that matter', () => {
  for (const key of ['api_key', 'apiKey', 'apikey', 'access_token', 'refresh_token', 'token',
                     'secret', 'client_secret', 'password', 'passphrase', 'authorization',
                     'bearer', 'private_key', 'x-api-key', 'signature']) {
    assert.equal(isCredentialKey(key), true, `${key} should be treated as a credential`)
  }
})

test('does NOT redact ordinary fields that merely resemble one', () => {
  // Over-redaction silently destroys config, so the rule must stay tight.
  for (const key of ['name', 'channel', 'tokenizer', 'passenger', 'authorised_by', 'secretary']) {
    assert.equal(isCredentialKey(key), false, `${key} should NOT be redacted`)
  }
})
