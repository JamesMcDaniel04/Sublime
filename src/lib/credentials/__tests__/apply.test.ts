/**
 * Applying an injection plan. The rule that matters: a user-supplied value
 * always wins, so attaching a saved credential can never silently override an
 * Authorization header someone deliberately typed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCredentialPlan } from '../apply'

test('injects a header when the request has none', () => {
  const out = applyCredentialPlan('https://api/x', {}, { headers: { authorization: 'Bearer k' } })
  assert.deepEqual(out.headers, { authorization: 'Bearer k' })
  assert.equal(out.url, 'https://api/x')
})

test('a user-supplied header wins, case-insensitively', () => {
  const out = applyCredentialPlan('https://api/x', { Authorization: 'Bearer mine' }, { headers: { authorization: 'Bearer cred' } })
  assert.deepEqual(out.headers, { Authorization: 'Bearer mine' })
})

test('an empty user header does NOT win — it is treated as absent', () => {
  // A template that resolved to '' must not block the credential and leave the
  // request carrying a blank credential instead.
  const out = applyCredentialPlan('https://api/x', { authorization: '   ' }, { headers: { authorization: 'Bearer cred' } })
  assert.equal(out.headers.authorization, 'Bearer cred')
})

test('injects a query param and preserves existing ones', () => {
  const out = applyCredentialPlan('https://api/x?page=2', {}, { query: { api_key: 'k' } })
  const url = new URL(out.url)
  assert.equal(url.searchParams.get('api_key'), 'k')
  assert.equal(url.searchParams.get('page'), '2')
})

test('a user-supplied query param wins', () => {
  const out = applyCredentialPlan('https://api/x?api_key=mine', {}, { query: { api_key: 'cred' } })
  assert.equal(new URL(out.url).searchParams.get('api_key'), 'mine')
})

test('an empty plan changes nothing', () => {
  const out = applyCredentialPlan('https://api/x', { accept: 'json' }, {})
  assert.deepEqual(out.headers, { accept: 'json' })
  assert.equal(out.url, 'https://api/x')
})

test('an unparseable URL is returned unchanged rather than throwing', () => {
  const out = applyCredentialPlan('not a url', {}, { query: { k: 'v' } })
  assert.equal(out.url, 'not a url')
})

test('does not mutate the caller headers object', () => {
  const headers = { accept: 'json' }
  applyCredentialPlan('https://api/x', headers, { headers: { authorization: 'Bearer k' } })
  assert.deepEqual(headers, { accept: 'json' }, 'caller headers were mutated')
})
