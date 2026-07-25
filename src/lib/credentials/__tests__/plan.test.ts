/**
 * Injection plan + egress allow-list. Both pure, and both security-relevant:
 * the plan decides what a credential adds to a request, the allow-list decides
 * whether it may be sent at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialInjectionPlan, isRequestUrlAllowed } from '../plan'

test('bearer injects an Authorization header', () => {
  assert.deepEqual(credentialInjectionPlan({ type: 'bearer', token: 'sk-1' }), {
    headers: { authorization: 'Bearer sk-1' },
  })
})

test('basic base64-encodes user:pass', () => {
  const plan = credentialInjectionPlan({ type: 'basic', username: 'joe', password: 'pw' })
  assert.equal(plan.headers?.authorization, `Basic ${Buffer.from('joe:pw').toString('base64')}`)
})

test('apiKeyHeader injects under its own header name', () => {
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'k' }), {
    headers: { 'X-API-Key': 'k' },
  })
})

test('apiKeyQuery injects a query param, never a header', () => {
  const plan = credentialInjectionPlan({ type: 'apiKeyQuery', queryParam: 'api_key', key: 'k' })
  assert.deepEqual(plan, { query: { api_key: 'k' } })
  assert.equal(plan.headers, undefined)
})

test('custom merges named headers and query params', () => {
  const plan = credentialInjectionPlan({
    type: 'custom',
    headers: [{ name: 'X-A', value: 'a' }],
    query: [{ name: 'q', value: 'b' }],
  })
  assert.deepEqual(plan, { headers: { 'X-A': 'a' }, query: { q: 'b' } })
})

test('an incomplete credential injects NOTHING rather than a blank header', () => {
  // A half-configured credential must not send `Authorization: Bearer ` or an
  // empty api-key header — that reads to the remote as a malformed credential.
  assert.deepEqual(credentialInjectionPlan({ type: 'bearer' }), {})
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyHeader', headerName: 'X', key: undefined }), {})
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyHeader', headerName: '  ', key: 'k' }), {})
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyQuery', queryParam: '', key: 'k' }), {})
  assert.deepEqual(credentialInjectionPlan({ type: 'custom', headers: [], query: [] }), {})
})

test('an empty allow-list permits any host', () => {
  assert.equal(isRequestUrlAllowed('https://anything.example.com/x', []), true)
})

test('allow-list matches the exact host and its subdomains', () => {
  assert.equal(isRequestUrlAllowed('https://api.acme.com/x', ['acme.com']), true)
  assert.equal(isRequestUrlAllowed('https://acme.com/x', ['acme.com']), true)
  assert.equal(isRequestUrlAllowed('https://deep.api.acme.com/x', ['acme.com']), true)
})

test('allow-list rejects a lookalike host', () => {
  // The bug this guards: endsWith('acme.com') alone would allow
  // "notacme.com" and "acme.com.evil.tld".
  assert.equal(isRequestUrlAllowed('https://notacme.com/x', ['acme.com']), false)
  assert.equal(isRequestUrlAllowed('https://acme.com.evil.tld/x', ['acme.com']), false)
})

test('allow-list is case-insensitive and tolerates a leading dot', () => {
  assert.equal(isRequestUrlAllowed('https://API.Acme.COM/x', ['.ACME.com']), true)
})

test('an unparseable URL is rejected when a list is set', () => {
  // Never send a credential to a target we could not parse well enough to check.
  assert.equal(isRequestUrlAllowed('not a url', ['acme.com']), false)
})

test('a blank allow-list entry does not match everything', () => {
  assert.equal(isRequestUrlAllowed('https://acme.com/x', ['   ']), false)
})
