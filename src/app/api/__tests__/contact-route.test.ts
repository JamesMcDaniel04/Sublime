/**
 * The public contact form is the only unauthenticated POST that spends money
 * (a Resend send per submission). The honeypot filters dumb bots; the rate
 * limit is the backstop for scripted ones — per client IP, checked before
 * any other work.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const body = (over: Record<string, unknown> = {}) => ({
  name: 'QA',
  email: 'qa@example.com',
  reason: 'other',
  message: 'hello',
  ...over,
})

const post = async (payload: Record<string, unknown>, ip = '203.0.113.7') => {
  const { POST } = await import('../contact/route')
  return POST(
    new NextRequest(new URL('http://test/api/contact'), {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    } as never),
  )
}

test('invalid submission is a 400', async () => {
  const res = await post(body({ email: 'not-an-email' }))
  assert.equal(res.status, 400)
})

test('honeypot submissions get a quiet success and send nothing', async () => {
  delete process.env.RESEND_API_KEY
  // With no Resend key a REAL submission would 503 — a honeypot hit must
  // short-circuit to success before ever reaching the send path.
  const res = await post(body({ website: 'http://spam' }), '203.0.113.8')
  assert.equal(res.status, 200)
})

test('rapid submissions from one IP are rate limited', async () => {
  delete process.env.RESEND_API_KEY
  let limited = 0
  for (let i = 0; i < 25; i++) {
    const res = await post(body(), '203.0.113.9')
    if (res.status === 429) limited += 1
  }
  assert.ok(limited > 0, 'expected at least one 429 within 25 rapid submissions')
  // A different IP is not affected by that flood (per-IP key, not global-only).
  const other = await post(body(), '203.0.113.10')
  assert.notEqual(other.status, 429)
})
