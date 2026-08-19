/**
 * Public webhook routes (flow/agent trigger, resume, Slack) authenticate by a
 * per-resource secret, bypassing withAuthenticatedApi — so they also bypassed
 * the auth.failed security signal. A wrong secret emitted nothing, making a
 * brute-force over the one unauthenticated surface invisible. These lock the
 * pure pieces: client-IP extraction and the event the routes emit on a 401.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp, webhookAuthFailureEvent, readBodyWithLimit, PayloadTooLargeError, MAX_WEBHOOK_BODY_BYTES } from '../webhook-guard'

const req = (headers: Record<string, string>) =>
  new Request('https://app.test/api/agents/a1/trigger', { method: 'POST', headers })

test('clientIp takes the first x-forwarded-for hop', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7')
})

test('clientIp falls back to x-real-ip, then unknown', () => {
  assert.equal(clientIp(req({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9')
  assert.equal(clientIp(req({})), 'unknown')
})

test('webhookAuthFailureEvent is an auth.failed event sourced to the caller IP', () => {
  const event = webhookAuthFailureEvent(req({ 'x-forwarded-for': '203.0.113.7' }), {
    route: 'agent.trigger',
    resourceId: 'a1',
    reason: 'invalid_secret',
  })
  assert.equal(event.kind, 'auth.failed')
  assert.equal(event.source, '203.0.113.7')
  assert.equal(event.detail?.route, 'agent.trigger')
  assert.equal(event.detail?.resourceId, 'a1')
  assert.equal(event.detail?.reason, 'invalid_secret')
})

test('readBodyWithLimit returns a small body and rejects an oversized declared length', async () => {
  const small = new Request('https://app.test/x', { method: 'POST', body: 'hello' })
  assert.equal(await readBodyWithLimit(small), 'hello')

  const lying = new Request('https://app.test/x', {
    method: 'POST',
    headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) },
    body: 'x',
  })
  await assert.rejects(readBodyWithLimit(lying), (e) => e instanceof PayloadTooLargeError)
})

test('readBodyWithLimit rejects a streamed body that exceeds the cap', async () => {
  const oversized = 'a'.repeat(MAX_WEBHOOK_BODY_BYTES + 10)
  const req = new Request('https://app.test/x', { method: 'POST', body: oversized })
  await assert.rejects(readBodyWithLimit(req), (e) => e instanceof PayloadTooLargeError)
})

test('webhookAuthFailureEvent never carries the presented secret', () => {
  // detail is built from route metadata only — the secret must never ride along
  // into the security log, even redacted.
  const event = webhookAuthFailureEvent(req({ 'x-forwarded-for': '203.0.113.7', 'x-trigger-secret': 'super-secret-value' }), {
    route: 'flow.trigger',
    resourceId: 'f1',
    reason: 'missing_secret',
  })
  assert.ok(!JSON.stringify(event).includes('super-secret-value'))
})
