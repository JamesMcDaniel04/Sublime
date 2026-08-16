import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactedExcerpt } from '@/lib/llm/step-excerpt'

/**
 * Copilot read tools hand persisted step rows to the model. The loop fences
 * them and masks token-SHAPED strings (redactSecrets); this helper closes the
 * other class — a credential identified by its KEY NAME, which no pattern
 * matcher would catch because the value is just an opaque string.
 */

test('a credential-named key is redacted out of a step excerpt', () => {
  const out = redactedExcerpt({ status: 200, access_token: 'opaque-value-no-pattern' }, 4000)
  assert.doesNotMatch(out, /opaque-value-no-pattern/)
  assert.match(out, /"access_token":"redacted"/)
})

test('nested credentials are redacted', () => {
  const out = redactedExcerpt({ data: [{ auth: { password: 'hunter2' } }] }, 4000)
  assert.doesNotMatch(out, /hunter2/)
})

test('ordinary payload fields survive', () => {
  const out = redactedExcerpt({ email: 'ada@example.com', count: 3 }, 4000)
  assert.match(out, /ada@example\.com/)
  assert.match(out, /"count":3/)
})

test('excerpts longer than max are clipped with a marker', () => {
  const out = redactedExcerpt({ blob: 'x'.repeat(500) }, 100)
  assert.ok(out.length < 200)
  assert.match(out, /… \[truncated\]$/)
})

test('nullish values become an empty excerpt', () => {
  assert.equal(redactedExcerpt(null, 100), '')
  assert.equal(redactedExcerpt(undefined, 100), '')
})

test('a plain string passes through without JSON quoting', () => {
  assert.equal(redactedExcerpt('INVALID_SESSION_ID', 100), 'INVALID_SESSION_ID')
})

test('redaction reaches into a JSON-encoded string value', () => {
  const out = redactedExcerpt(JSON.stringify({ client_secret: 'SHHH', ok: true }), 4000)
  assert.doesNotMatch(out, /SHHH/)
})
