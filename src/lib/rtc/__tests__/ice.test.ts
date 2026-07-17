import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'crypto'
import { DEFAULT_STUN_SERVERS, TURN_CREDENTIAL_TTL_SECONDS, iceServersFromEnv } from '../ice'

test('no TURN env yields the STUN-only fallback (never an empty list)', () => {
  assert.deepEqual(iceServersFromEnv({}, 1_700_000_000), DEFAULT_STUN_SERVERS)
  assert.ok(DEFAULT_STUN_SERVERS.length > 0)
})

test('static TURN credentials are passed through alongside STUN', () => {
  const servers = iceServersFromEnv(
    {
      TURN_URLS: 'turn:turn.example.com:3478, turns:turn.example.com:5349',
      TURN_STATIC_USERNAME: 'sublime',
      TURN_STATIC_CREDENTIAL: 'hunter2',
    },
    1_700_000_000,
  )
  const turn = servers.find((server) => server.username)
  assert.ok(turn, 'a TURN entry is present')
  assert.deepEqual(turn?.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], 'urls are split and trimmed')
  assert.equal(turn?.username, 'sublime')
  assert.equal(turn?.credential, 'hunter2')
  assert.ok(servers.some((server) => String(server.urls[0]).startsWith('stun:')), 'STUN stays as fallback')
})

test('shared-secret mode mints coturn REST credentials: username = expiry, credential = HMAC-SHA1', () => {
  const now = 1_700_000_000
  const servers = iceServersFromEnv({ TURN_URLS: 'turn:relay.example.com:3478', TURN_SHARED_SECRET: 's3cret' }, now)
  const turn = servers.find((server) => server.username)
  assert.ok(turn)
  const expectedUsername = String(now + TURN_CREDENTIAL_TTL_SECONDS)
  assert.equal(turn?.username, expectedUsername, 'username is the unix expiry (time-limited credential)')
  const expectedCredential = createHmac('sha1', 's3cret').update(expectedUsername).digest('base64')
  assert.equal(turn?.credential, expectedCredential)
})

test('a shared secret without urls is inert — STUN only, no half-configured TURN entry', () => {
  assert.deepEqual(iceServersFromEnv({ TURN_SHARED_SECRET: 's3cret' }, 1_700_000_000), DEFAULT_STUN_SERVERS)
})
