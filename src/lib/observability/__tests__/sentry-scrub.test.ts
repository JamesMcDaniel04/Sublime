/**
 * Sentry is the second place this process hands data to a third party (the LLM
 * transcript is the first). redactSecrets guarded the transcript and not this,
 * so events left verbatim — including error messages carrying a tokenised URL
 * and any `context` a caller passed through as `extra`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubSentryEvent } from '../sentry'

test('scrubs a secret out of the exception message', () => {
  const event = {
    exception: { values: [{ value: 'Request failed: Bearer abcdefghijklmnopqrstuvwxyz0123456789' }] },
  }
  const scrubbed = scrubSentryEvent(event)
  const value = scrubbed.exception.values[0].value
  assert.ok(!value.includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'bearer token reached Sentry')
  assert.match(value, /\[redacted:/)
})

test('scrubs nested extra context, which is how captureError passes detail', () => {
  const scrubbed = scrubSentryEvent({
    message: 'connection failed',
    extra: { path: '/api/x', config: { token: 'xoxb-1234567890-abcdefghij' } },
  })
  const serialized = JSON.stringify(scrubbed)
  assert.ok(!serialized.includes('xoxb-1234567890-abcdefghij'), 'slack token reached Sentry via extra')
})

test('leaves ordinary diagnostic content intact', () => {
  const scrubbed = scrubSentryEvent({
    message: 'Flow run failed at step 3',
    extra: { organizationId: 'org-123', durationMs: 4210 },
  })
  assert.equal(scrubbed.message, 'Flow run failed at step 3')
  assert.equal(scrubbed.extra.organizationId, 'org-123')
  assert.equal(scrubbed.extra.durationMs, 4210)
})

test('an unserializable event still gets its message and exception scrubbed', () => {
  // Circular reference: JSON.stringify throws, so the round-trip cannot run.
  // The fallback must still scrub rather than pass the event through.
  const circular: Record<string, unknown> = { message: 'key sk-ant-api03-abcdefghijklmnop1234 here' }
  circular.self = circular
  const scrubbed = scrubSentryEvent(circular) as { message: string }
  assert.ok(!scrubbed.message.includes('sk-ant-api03-abcdefghijklmnop1234'), 'fallback path leaked the key')
})
