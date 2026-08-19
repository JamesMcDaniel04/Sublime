/**
 * Agent run-data encryption at rest. The key property beyond round-tripping is
 * that at-rest storage is CIPHERTEXT (a dump reveals nothing), while reads of
 * legacy plaintext still work — so this could land without a data migration.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY

async function fresh() {
  return import('../run-crypto')
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'run-data-test-key-0123456789abcdef'
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY
})

test('a Json run value round-trips and is stored as ciphertext', async () => {
  const { encryptRunValue, decryptRunValue } = await fresh()
  const transcript = [{ role: 'user', content: 'my API key is sk-secret' }, { role: 'assistant', content: 'ok' }]
  const stored = encryptRunValue(transcript)
  assert.equal(typeof stored, 'string')
  assert.match(String(stored), /^v2:/)
  assert.ok(!String(stored).includes('sk-secret'), 'plaintext survived into at-rest form')
  assert.deepEqual(decryptRunValue(stored), transcript)
})

test('text content round-trips and is stored as ciphertext', async () => {
  const { encryptRunText, decryptRunText } = await fresh()
  const stored = encryptRunText('the customer said their SSN is 123-45-6789')
  assert.match(stored, /^v2:/)
  assert.ok(!stored.includes('123-45-6789'))
  assert.equal(decryptRunText(stored), 'the customer said their SSN is 123-45-6789')
})

test('reads pass through legacy plaintext unchanged (no migration required)', async () => {
  const { decryptRunValue, decryptRunText } = await fresh()
  assert.deepEqual(decryptRunValue({ prompt: 'legacy object' }), { prompt: 'legacy object' })
  assert.equal(decryptRunText('legacy plaintext message'), 'legacy plaintext message')
})

test('without a key, storage is an identity passthrough (dev/keyless suites unaffected)', async () => {
  delete process.env.ENCRYPTION_KEY
  const { encryptRunValue, encryptRunText, decryptRunValue } = await fresh()
  assert.deepEqual(encryptRunValue({ a: 1 }), { a: 1 })
  assert.equal(encryptRunText('plain'), 'plain')
  assert.deepEqual(decryptRunValue({ a: 1 }), { a: 1 })
})

test('null and undefined are preserved, not encrypted', async () => {
  const { encryptRunValue, decryptRunValue } = await fresh()
  assert.equal(decryptRunValue(null), null)
  assert.equal(decryptRunValue(undefined), null)
  assert.equal(encryptRunValue(null), null)
})
