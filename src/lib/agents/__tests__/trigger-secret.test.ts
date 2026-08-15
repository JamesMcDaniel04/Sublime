/**
 * Agent webhook trigger secrets: new secrets are stored hash+ciphertext, but
 * rows minted before hashing kept a PLAINTEXT metadata.triggerSecret that the
 * trigger route accepted forever. Validation must keep accepting them (old
 * integrations must not break), but a successful legacy match must UPGRADE the
 * row in place — hash + encrypt, delete the plaintext — so the plaintext
 * population only ever shrinks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashToken, encryptionConfigured } from '@/lib/crypto/secrets'
import { validateTriggerSecret } from '../trigger-secret'

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key-0123456789abcdef01'

test('valid hashed secret: accepted, no upgrade needed', () => {
  const metadata = { triggerSecretHash: hashToken('s3cret') }
  const result = validateTriggerSecret('s3cret', metadata)
  assert.equal(result.valid, true)
  assert.equal(result.upgrade, null)
})

test('wrong secret against a hash: rejected', () => {
  const metadata = { triggerSecretHash: hashToken('s3cret') }
  assert.equal(validateTriggerSecret('wrong', metadata).valid, false)
})

test('legacy plaintext match: accepted AND returns upgraded metadata without the plaintext', () => {
  assert.ok(encryptionConfigured(), 'test requires ENCRYPTION_KEY')
  const metadata = { triggerSecret: 'legacy-secret', title: 'My agent' }
  const result = validateTriggerSecret('legacy-secret', metadata)
  assert.equal(result.valid, true)
  assert.ok(result.upgrade, 'legacy match must produce an upgrade')
  assert.equal(result.upgrade.triggerSecret, undefined, 'plaintext survived the upgrade')
  assert.equal(result.upgrade.triggerSecretHash, hashToken('legacy-secret'))
  assert.match(String(result.upgrade.triggerSecretEnc), /^v2:/)
  assert.equal(result.upgrade.title, 'My agent', 'unrelated metadata was lost')
})

test('legacy plaintext mismatch: rejected, no upgrade', () => {
  const result = validateTriggerSecret('wrong', { triggerSecret: 'legacy-secret' })
  assert.equal(result.valid, false)
  assert.equal(result.upgrade, null)
})

test('hash takes precedence over a stale legacy field', () => {
  // A row that carries BOTH (half-finished upgrade) must validate against the
  // hash — and a legacy value matching only the stale plaintext is rejected.
  const metadata = { triggerSecretHash: hashToken('new'), triggerSecret: 'old' }
  assert.equal(validateTriggerSecret('new', metadata).valid, true)
  assert.equal(validateTriggerSecret('old', metadata).valid, false)
})

test('no secret material at all: rejected', () => {
  assert.equal(validateTriggerSecret('anything', {}).valid, false)
})
