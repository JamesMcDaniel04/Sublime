import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
})

test('refresh tokens survive the encrypt/decrypt round trip used by the store', () => {
  const token = '1//0refresh-token-payload'
  assert.equal(decryptSecret(encryptSecret(token)), token)
})

test('store module exposes the four connection operations', async () => {
  const store = await import('../store')
  assert.equal(typeof store.upsertGoogleConnection, 'function')
  assert.equal(typeof store.getGoogleConnection, 'function')
  assert.equal(typeof store.markGoogleConnectionError, 'function')
  assert.equal(typeof store.deleteGoogleConnection, 'function')
})
