import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertLiteralOriginForConnectionAuth, usableConnectionToken } from '../http-auth'

const NOW = 1_750_000_000_000

test('usableConnectionToken returns a fresh oauth2 authcode access token', () => {
  const token = usableConnectionToken(
    { authType: 'oauth2', flow: 'authcode', accessToken: 'tok-fresh', expiresAt: NOW + 3_600_000 },
    NOW,
  )
  assert.equal(token, 'tok-fresh')
})

test('usableConnectionToken rejects an authcode token expired beyond the clock-skew grace', () => {
  // A failed refresh returns the row unchanged — the stale token must not be injected
  assert.equal(
    usableConnectionToken(
      { authType: 'oauth2', flow: 'authcode', accessToken: 'tok-stale', expiresAt: NOW - 61_000 },
      NOW,
    ),
    undefined,
  )
  // Exactly at the grace boundary counts as expired
  assert.equal(
    usableConnectionToken(
      { authType: 'oauth2', flow: 'authcode', accessToken: 'tok-stale', expiresAt: NOW - 60_000 },
      NOW,
    ),
    undefined,
  )
})

test('usableConnectionToken rejects a token at or past its expiry — the refresher already failed it', () => {
  assert.equal(
    usableConnectionToken(
      { authType: 'oauth2', flow: 'authcode', accessToken: 'tok-edge', expiresAt: NOW - 30_000 },
      NOW,
    ),
    undefined,
  )
  // Still valid for a few seconds → inject (the refresher handles renewal).
  assert.equal(
    usableConnectionToken(
      { authType: 'oauth2', flow: 'authcode', accessToken: 'tok-live', expiresAt: NOW + 5_000 },
      NOW,
    ),
    'tok-live',
  )
})

test('usableConnectionToken keeps authcode tokens with no tracked expiry', () => {
  assert.equal(
    usableConnectionToken({ authType: 'oauth2', flow: 'authcode', accessToken: 'tok-no-exp' }, NOW),
    'tok-no-exp',
  )
})

test('usableConnectionToken returns undefined for authcode rows without an access token', () => {
  assert.equal(
    usableConnectionToken({ authType: 'oauth2', flow: 'authcode', expiresAt: NOW + 3_600_000 }, NOW),
    undefined,
  )
  assert.equal(
    usableConnectionToken({ authType: 'oauth2', flow: 'authcode', accessToken: '' }, NOW),
    undefined,
  )
})

test('usableConnectionToken accepts api_key rows only as Bearer Authorization, with no expiry check', () => {
  assert.equal(usableConnectionToken({ authType: 'api_key', apiKey: 'key-1' }, NOW), 'key-1')
  assert.equal(
    usableConnectionToken({ authType: 'api_key', apiKey: 'key-1', headerName: 'Authorization' }, NOW),
    'key-1',
  )
  // api_key rows track no expiry — an expiresAt field never disqualifies them
  assert.equal(
    usableConnectionToken({ authType: 'api_key', apiKey: 'key-1', expiresAt: NOW - 999_999 }, NOW),
    'key-1',
  )
  // Custom header names are not injectable as a bearer token
  assert.equal(
    usableConnectionToken({ authType: 'api_key', apiKey: 'key-1', headerName: 'X-Api-Key' }, NOW),
    undefined,
  )
})

test('usableConnectionToken returns undefined for other auth types', () => {
  assert.equal(usableConnectionToken({ authType: 'none' }, NOW), undefined)
  assert.equal(usableConnectionToken({ authType: 'oauth2', accessToken: 'tok-cc' }, NOW), undefined)
  assert.equal(usableConnectionToken({}, NOW), undefined)
})

test('assertLiteralOriginForConnectionAuth accepts literal origins with templated paths', () => {
  for (const [template, resolved] of [
    ['https://api.example.com/items', 'https://api.example.com/items'],
    ['https://api.example.com/{{upstream.id}}', 'https://api.example.com/42'],
    ['https://api.example.com/v1?q={{trigger.input}}', 'https://api.example.com/v1?q=hello'],
  ] as const) {
    assert.doesNotThrow(() => assertLiteralOriginForConnectionAuth(template, resolved))
  }
})

test('assertLiteralOriginForConnectionAuth rejects templated or mismatched origins', () => {
  const cases: Array<[string, string]> = [
    // Host assembled from upstream data.
    ['https://{{vars.host}}/path', 'https://evil.example.net/path'],
    // Whole URL templated.
    ['{{upstream.url}}', 'https://evil.example.net/x'],
    // Literal prefix parses but resolved host was extended past it.
    ['https://api.example.com{{suffix}}/p', 'https://api.example.com.evil.net/p'],
    // Templated port shifts the origin.
    ['https://api.example.com:{{port}}/p', 'https://api.example.com:8443/p'],
    // Resolved URL is not even a URL.
    ['https://api.example.com/x', 'not-a-url'],
  ]
  for (const [template, resolved] of cases) {
    assert.throws(() => assertLiteralOriginForConnectionAuth(template, resolved), /origin/)
  }
})
