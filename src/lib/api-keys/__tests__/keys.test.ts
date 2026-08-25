/**
 * API key format, hashing and scope checks.
 *
 * The design constraint that shapes everything here: the plaintext key is
 * shown once and never stored. So the database must be able to FIND the right
 * row without the plaintext being reversible — hence a public prefix that
 * identifies the row and a hash that proves it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateApiKey,
  parseApiKey,
  API_KEY_PREFIX,
  API_SCOPES,
  scopeSatisfies,
  normalizeScopes,
} from '../keys'

// ── generating ──────────────────────────────────────────────────────────────

test('a generated key carries a public prefix and a secret', () => {
  const key = generateApiKey()
  assert.match(key.plaintext, new RegExp(`^${API_KEY_PREFIX}`))
  assert.ok(key.prefix.length >= 8)
  assert.ok(key.hash.length === 64, 'the stored value must be a sha256 digest')
})

test('the plaintext is never equal to what is stored', () => {
  const key = generateApiKey()
  assert.notEqual(key.plaintext, key.hash)
  assert.ok(!key.hash.includes(key.plaintext))
})

test('two keys never collide', () => {
  const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().plaintext))
  assert.equal(keys.size, 200)
})

// The secret needs enough entropy that guessing is hopeless even with the
// prefix known — the prefix is public by design.
test('the secret half carries at least 128 bits of entropy', () => {
  const { plaintext, prefix } = generateApiKey()
  const secret = plaintext.slice(`${API_KEY_PREFIX}${prefix}_`.length)
  // base62-ish alphabet: log2(62) ≈ 5.95 bits per character.
  assert.ok(secret.length >= 22, `secret was only ${secret.length} characters`)
})

// ── parsing ─────────────────────────────────────────────────────────────────

test('a presented key yields the prefix used to find its row', () => {
  const key = generateApiKey()
  assert.equal(parseApiKey(key.plaintext)?.prefix, key.prefix)
})

test('a presented key hashes to the stored value', () => {
  const key = generateApiKey()
  assert.equal(parseApiKey(key.plaintext)?.hash, key.hash)
})

test('a key without the expected prefix is refused', () => {
  assert.equal(parseApiKey('bearer-token-from-somewhere-else'), null)
  assert.equal(parseApiKey(''), null)
})

test('a key with no secret half is refused', () => {
  assert.equal(parseApiKey(`${API_KEY_PREFIX}abcdefgh_`), null)
  assert.equal(parseApiKey(`${API_KEY_PREFIX}abcdefgh`), null)
})

// ── scopes ──────────────────────────────────────────────────────────────────

test('a key with a scope satisfies that scope', () => {
  assert.equal(scopeSatisfies(['flows:read'], 'flows:read'), true)
})

test('a key without a scope does not satisfy it', () => {
  assert.equal(scopeSatisfies(['flows:read'], 'flows:write'), false)
})

// Write implies read for the same resource: a key allowed to change flows
// being unable to list them is a papercut with no security value.
test('write implies read on the same resource', () => {
  assert.equal(scopeSatisfies(['flows:write'], 'flows:read'), true)
})

test('read does not imply write', () => {
  assert.equal(scopeSatisfies(['flows:read'], 'flows:write'), false)
})

test('a scope on one resource says nothing about another', () => {
  assert.equal(scopeSatisfies(['flows:write'], 'agents:read'), false)
})

test('no scopes satisfies nothing', () => {
  assert.equal(scopeSatisfies([], 'flows:read'), false)
})

// An unrecognised scope must not be storable — otherwise a typo silently
// produces a key that grants nothing, or a future scope name grants access
// retroactively when it is added.
test('unknown scopes are dropped rather than stored', () => {
  assert.deepEqual(normalizeScopes(['flows:read', 'not-a-scope', '']), ['flows:read'])
})

test('duplicate scopes collapse', () => {
  assert.deepEqual(normalizeScopes(['flows:read', 'flows:read']), ['flows:read'])
})

test('every advertised scope is accepted by the normaliser', () => {
  assert.deepEqual(normalizeScopes([...API_SCOPES]).sort(), [...API_SCOPES].sort())
})

// A wildcard would make every future scope automatically granted to keys
// issued today, which is the opposite of what a scoped key is for.
test('there is no wildcard scope', () => {
  assert.ok(!API_SCOPES.includes('*' as never))
  assert.equal(scopeSatisfies(['*'], 'flows:read'), false)
})

// Regression. `_` separates the prefix from the secret, and the base64url
// alphabet contains `_` — so a base64url prefix would be split in the wrong
// place and the key would fail to authenticate. Intermittently, for about one
// key in eight, which is the worst way for this to be discovered.
test('a generated prefix never contains the field separator', () => {
  for (let i = 0; i < 500; i++) {
    assert.ok(!generateApiKey().prefix.includes('_'), 'a prefix contained the separator')
  }
})

test('every generated key round-trips through parsing', () => {
  for (let i = 0; i < 500; i++) {
    const key = generateApiKey()
    const parsed = parseApiKey(key.plaintext)
    assert.equal(parsed?.prefix, key.prefix)
    assert.equal(parsed?.hash, key.hash)
  }
})
