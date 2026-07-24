import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTriggerSecret, withTriggerSecret, readTriggerSecret } from '../webhook-secret'
import { hashToken } from '@/lib/crypto/secrets'
import { preserveWebhookSecretHash } from '../trigger'

test('mint → store → read round-trips, and the hash still validates', () => {
  const secret = newTriggerSecret()
  assert.ok(secret.length >= 30)
  const trigger = withTriggerSecret({ type: 'webhook' }, secret)
  assert.equal(trigger.webhookSecretHash, hashToken(secret))
  assert.equal(readTriggerSecret(trigger), secret)
})

test('readTriggerSecret returns null for legacy hash-only triggers', () => {
  assert.equal(readTriggerSecret({ type: 'webhook', webhookSecretHash: 'abc' }), null)
  assert.equal(readTriggerSecret(undefined), null)
})

test('preserveWebhookSecretHash carries BOTH hash and ciphertext across edits', () => {
  const secret = newTriggerSecret()
  const stored = withTriggerSecret({ type: 'webhook' }, secret)
  const next = preserveWebhookSecretHash({ type: 'webhook', schedule: 'x' }, stored)
  assert.equal(next.webhookSecretHash, stored.webhookSecretHash)
  assert.equal(next.webhookSecretEnc, stored.webhookSecretEnc, 'a plain save must not wipe the ciphertext')
})
