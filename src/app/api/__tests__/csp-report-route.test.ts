/**
 * The CSP violation sink is world-writable by necessity — browsers post reports
 * without credentials. That makes its failure modes the interesting part: it
 * must never error, never leak, and never become a free log-spam channel.
 *
 * No database required; the route reads no tenant data by design.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const post = async (body: unknown, init: { ip?: string; contentLength?: number } = {}) => {
  const { POST } = await import('../security/csp-report/route')
  const headers: Record<string, string> = {
    'content-type': 'application/csp-report',
    'x-forwarded-for': init.ip ?? '198.51.100.4',
  }
  if (init.contentLength !== undefined) headers['content-length'] = String(init.contentLength)
  return POST(
    new NextRequest(new URL('http://test/api/security/csp-report'), {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers,
    } as never),
  )
}

test('accepts a legacy report-uri payload with 204 and no body', async () => {
  const response = await post({
    'csp-report': {
      'violated-directive': "script-src 'self'",
      'blocked-uri': 'https://evil.example/x.js',
      'document-uri': 'https://app.example/dashboard',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
})

test('accepts a Reporting API payload', async () => {
  const response = await post([
    {
      type: 'csp-violation',
      body: {
        effectiveDirective: 'script-src',
        blockedURL: 'https://evil.example/x.js',
        documentURL: 'https://app.example/dashboard',
      },
    },
  ], { ip: '198.51.100.5' })
  assert.equal(response.status, 204)
})

test('malformed and unparseable bodies still answer 204', async () => {
  // A browser cannot act on an error here, and a non-2xx only makes it retry —
  // so every path returns 204, including the ones that log nothing.
  assert.equal((await post('not json at all', { ip: '198.51.100.6' })).status, 204)
  assert.equal((await post({ unexpected: 'shape' }, { ip: '198.51.100.7' })).status, 204)
  assert.equal((await post(null, { ip: '198.51.100.8' })).status, 204)
})

test('an oversized report is dropped without being parsed', async () => {
  const response = await post({ 'csp-report': { 'violated-directive': 'x' } }, {
    ip: '198.51.100.9',
    contentLength: 17 * 1024,
  })
  assert.equal(response.status, 204)
})

test('a flood from one IP is rate limited, still with 204', async () => {
  // The endpoint is world-writable; without a limit it is a free way to fill
  // the log pipeline. 204 throughout so a violating page does not retry harder.
  for (let i = 0; i < 80; i += 1) {
    const response = await post({ 'csp-report': { 'violated-directive': 'script-src' } }, { ip: '198.51.100.10' })
    assert.equal(response.status, 204)
  }
})
