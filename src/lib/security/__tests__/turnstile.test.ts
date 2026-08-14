import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { assertHumanToken, TurnstileError, turnstileConfigured } from '../turnstile'

const ok = async () => new Response(JSON.stringify({ success: true }), { status: 200 })
const bad = async () =>
  new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 })

beforeEach(() => {
  delete process.env.TURNSTILE_SECRET_KEY
})

test('no-ops when unconfigured, so a keyless dev machine is unaffected', async () => {
  assert.equal(turnstileConfigured(), false)
  await assertHumanToken(undefined)
  await assertHumanToken('anything')
})

test('rejects a missing token once configured', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  assert.equal(turnstileConfigured(), true)
  await assert.rejects(() => assertHumanToken(undefined, undefined, ok), TurnstileError)
  await assert.rejects(() => assertHumanToken('', undefined, ok), TurnstileError)
})

test('rejects a token Cloudflare refuses', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  await assert.rejects(() => assertHumanToken('bad-token', undefined, bad), TurnstileError)
})

test('accepts a token Cloudflare validates', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  await assertHumanToken('good-token', '1.2.3.4', ok)
})

test('forwards the secret, token and remote ip to the siteverify endpoint', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'shhh'
  const calls: Array<{ url: string; body: string }> = []
  const spy = async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init.body) })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
  await assertHumanToken('tok', '9.9.9.9', spy as any)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/)
  const params = new URLSearchParams(calls[0].body)
  assert.equal(params.get('secret'), 'shhh')
  assert.equal(params.get('response'), 'tok')
  assert.equal(params.get('remoteip'), '9.9.9.9')
})

test('fails CLOSED when Cloudflare is unreachable', async () => {
  // Deliberately the opposite of src/lib/ratelimit.ts, which fails OPEN and
  // says so. A limiter outage costs throughput; a captcha outage costs the
  // only thing standing between a public form and a bot. Nothing on the
  // critical login path depends on this helper — auth tokens are verified by
  // Supabase itself — so failing closed here cannot lock anyone out of the app.
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  const boom = async () => {
    throw new Error('network')
  }
  await assert.rejects(() => assertHumanToken('tok', undefined, boom), TurnstileError)
})

test('fails closed on a non-OK response from Cloudflare', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  const down = async () => new Response('gateway timeout', { status: 504 })
  await assert.rejects(() => assertHumanToken('tok', undefined, down), TurnstileError)
})
