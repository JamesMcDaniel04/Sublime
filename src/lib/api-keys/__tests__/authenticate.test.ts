/**
 * Authenticating a presented API key.
 *
 * The rules a key must clear before it authenticates anything: it exists, it
 * has not been revoked, it has not expired, and the hash matches in constant
 * time. Each of these is tested as a REFUSAL, because a bug in any one of them
 * is a bug that lets a caller in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticateApiKey } from '../authenticate'
import { generateApiKey } from '../keys'

const past = new Date(Date.now() - 60_000)
const future = new Date(Date.now() + 60_000)

/** A lookup stub standing in for the prefix-indexed database read. */
function lookupOf(row: Record<string, unknown> | null) {
  return async () => row
}

test('a valid key authenticates and reports its workspace', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: key.hash,
    scopes: ['flows:read'], revokedAt: null, expiresAt: null,
  }))
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.key.organizationId, 'org-1')
})

test('a revoked key is refused', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: key.hash,
    scopes: ['flows:read'], revokedAt: past, expiresAt: null,
  }))
  assert.equal(result.ok, false)
})

test('an expired key is refused', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: key.hash,
    scopes: ['flows:read'], revokedAt: null, expiresAt: past,
  }))
  assert.equal(result.ok, false)
})

test('a key expiring in the future is accepted', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: key.hash,
    scopes: ['flows:read'], revokedAt: null, expiresAt: future,
  }))
  assert.equal(result.ok, true)
})

// The core one: knowing a valid PREFIX must not be enough. The prefix is
// public by design, so a row found by prefix still has to prove the hash.
test('a key with a valid prefix but the wrong secret is refused', async () => {
  const real = generateApiKey()
  const forged = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${forged.plaintext}`, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: real.hash,
    scopes: ['flows:read'], revokedAt: null, expiresAt: null,
  }))
  assert.equal(result.ok, false)
})

test('an unknown key is refused', async () => {
  const key = generateApiKey()
  assert.equal((await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf(null))).ok, false)
})

test('a missing header is refused', async () => {
  assert.equal((await authenticateApiKey(null, lookupOf(null))).ok, false)
  assert.equal((await authenticateApiKey('', lookupOf(null))).ok, false)
})

test('a malformed header is refused', async () => {
  assert.equal((await authenticateApiKey('Basic abc', lookupOf(null))).ok, false)
  assert.equal((await authenticateApiKey('Bearer', lookupOf(null))).ok, false)
})

// A key is offered bare as often as with the Bearer prefix.
test('a bare key without the Bearer prefix still authenticates', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(key.plaintext, lookupOf({
    id: 'k1', organizationId: 'org-1', hash: key.hash,
    scopes: ['flows:read'], revokedAt: null, expiresAt: null,
  }))
  assert.equal(result.ok, true)
})

// Every refusal must look the same from outside. A distinguishable "revoked"
// vs "unknown" tells an attacker which of their guesses was once real.
test('every refusal reports the same reason to the caller', async () => {
  const key = generateApiKey()
  const reasons = await Promise.all([
    authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf(null)),
    authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({ id: 'k1', organizationId: 'o', hash: key.hash, scopes: [], revokedAt: past, expiresAt: null })),
    authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf({ id: 'k1', organizationId: 'o', hash: key.hash, scopes: [], revokedAt: null, expiresAt: past })),
    authenticateApiKey('Bearer sk_sub_zzzzzzzz_nope', lookupOf(null)),
  ])
  const messages = new Set(reasons.map((r) => (r.ok ? 'ok' : r.error)))
  assert.equal(messages.size, 1, `refusals were distinguishable: ${[...messages].join(' | ')}`)
})

// The key must never appear in what we hand back — that value gets logged.
test('the plaintext key is not echoed in a refusal', async () => {
  const key = generateApiKey()
  const result = await authenticateApiKey(`Bearer ${key.plaintext}`, lookupOf(null))
  assert.ok(!JSON.stringify(result).includes(key.plaintext))
})
