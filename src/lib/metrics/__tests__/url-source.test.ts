import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSafeDestination,
  assertSafeUrl,
  extractJsonNumber,
  extractTextNumber,
  makeUrlMetricSource,
} from '../sources/url'

const resolveTo = (...addresses: string[]) =>
  (async () => addresses.map((address) => ({ address }))) as never
const publicDns = resolveTo('93.184.216.34')

test('assertSafeUrl: SSRF matrix — private, loopback, link-local, metadata, credentials, scheme', () => {
  for (const url of [
    'http://localhost/metrics',
    'http://app.localhost/metrics',
    'http://127.0.0.1:8080/x',
    'http://10.1.2.3/x',
    'http://172.16.9.1/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fd00::1]/x',
    'http://[fe80::1]/x',
    'http://[::ffff:10.0.0.1]/x',
    'http://redis.internal/x',
    'http://redis.internal./x', // trailing-dot FQDN spelling
    'http://localhost./x',
    'http://printer.local/x',
    'ftp://example.com/x',
    'file:///etc/passwd',
    'http://user:pass@example.com/x',
    'not a url',
  ]) {
    assert.throws(() => assertSafeUrl(url), `should reject ${url}`)
  }
  assert.equal(assertSafeUrl('https://status.example.com/mrr.json').hostname, 'status.example.com')
  // Public IPs and 172.x outside the private block are fine.
  assert.ok(assertSafeUrl('http://172.32.0.1/x'))
})

test('assertSafeDestination: DNS answers are vetted — rebinding-class names rejected', async () => {
  const url = new URL('https://evil.example.com/metrics')
  // A public name resolving to a private address is the DNS-based SSRF bypass.
  await assert.rejects(
    assertSafeDestination(url, resolveTo('10.0.0.5')),
    /Internal and private-network/,
  )
  await assert.rejects(
    assertSafeDestination(url, resolveTo('93.184.216.34', '169.254.169.254')),
    /Internal and private-network/, // ANY private answer rejects
  )
  await assert.rejects(assertSafeDestination(url, resolveTo()), /could not be resolved/)
  await assert.doesNotReject(assertSafeDestination(url, publicDns))
  // IP literals were vetted upstream — no resolver call for them.
  await assert.doesNotReject(
    assertSafeDestination(new URL('http://93.184.216.34/x'), (async () => {
      throw new Error('should not resolve literals')
    }) as never),
  )
})

test('extractJsonNumber: dot-path and breadth-first first-numeric', () => {
  const body = { meta: { note: 'q3' }, data: { mrr: { current: '41,203.50', previous: 39000 } } }
  assert.equal(extractJsonNumber(body, 'data.mrr.current'), 41203.5)
  assert.equal(extractJsonNumber(body, 'data.mrr.missing'), null)
  assert.equal(extractJsonNumber({ a: [{ b: 'x' }, { c: 77 }] }), 77)
  assert.equal(extractJsonNumber({ a: 'none here' }), null)
})

test('extractTextNumber: first number with currency/commas/percent', () => {
  assert.equal(extractTextNumber('MRR is $41,203.50 as of Friday'), 41203.5)
  assert.equal(extractTextNumber('conversion 3.2% this week'), 3.2 / 100)
  assert.equal(extractTextNumber('no numbers'), null)
})

test('fetchValue follows safe redirects, blocks unsafe hops, enforces parse', async () => {
  const calls: string[] = []
  const resolved: string[] = []
  const source = makeUrlMetricSource(
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://a.example.com/') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/data' } })
      }
      return new Response(JSON.stringify({ kpi: { value: 512 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
    async (url) => {
      resolved.push(url.hostname)
    },
  )
  const reading = await source.fetchValue(
    { organizationId: 'org', connectionRef: null, config: { url: 'https://a.example.com/' } },
    'url.value',
  )
  assert.equal(reading.value, 512)
  assert.deepEqual(calls, ['https://a.example.com/', 'https://b.example.com/data'])
  assert.deepEqual(resolved, ['a.example.com', 'b.example.com']) // every hop resolved

  const hostile = makeUrlMetricSource(
    (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })) as typeof fetch,
    async () => undefined,
  )
  await assert.rejects(
    hostile.fetchValue(
      { organizationId: 'org', connectionRef: null, config: { url: 'https://a.example.com/' } },
      'url.value',
    ),
    /Internal and private-network/,
  )
})
