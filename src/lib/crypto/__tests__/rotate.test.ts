import { test } from 'node:test'
import assert from 'node:assert/strict'

import { encryptSecretWithKey, decryptSecretWithKey } from '../secrets'
import { classifyCiphertext, rotateCiphertextsDeep, countCiphertextsDeep } from '../rotate'

const OLD = 'old-key-material'
const NEW = 'new-key-material'

test('a value encrypted under one key decrypts under that key and not another', () => {
  const payload = encryptSecretWithKey('sk-live-1', OLD)
  assert.equal(decryptSecretWithKey(payload, OLD), 'sk-live-1')
  assert.throws(() => decryptSecretWithKey(payload, NEW))
})

test('classify distinguishes real encryption from the reversible base64 fallback', () => {
  // New writes use the v2 envelope; v1 stays classified so rotation can still
  // find and migrate rows written before the derivation was upgraded.
  assert.equal(classifyCiphertext(encryptSecretWithKey('x', OLD)), 'v2')
  assert.equal(classifyCiphertext('v1:aXY=:dGFn:Y3Q='), 'v1')
  assert.equal(classifyCiphertext('b64:' + Buffer.from('x').toString('base64')), 'b64')
  assert.equal(classifyCiphertext('not a secret'), 'plaintext')
})

test('rotation rewrites a nested ciphertext so it opens under the new key only', () => {
  const stored = {
    type: 'custom',
    headers: [{ name: 'X-Key', value: encryptSecretWithKey('sk-nested', OLD) }],
    headerName: 'X-Key',
  }
  const { value: rotated, rotated: count } = rotateCiphertextsDeep(stored, OLD, NEW)
  assert.equal(count, 1)

  const rotatedValue = (rotated as typeof stored).headers[0].value
  assert.equal(decryptSecretWithKey(rotatedValue, NEW), 'sk-nested')
  assert.throws(() => decryptSecretWithKey(rotatedValue, OLD))
})

test('non-secret metadata survives rotation untouched', () => {
  const stored = { headerName: 'X-Key', enabled: true, count: 3, nothing: null }
  const { value: rotated, rotated: count } = rotateCiphertextsDeep(stored, OLD, NEW)
  assert.equal(count, 0)
  assert.deepEqual(rotated, stored)
})

test('the base64 fallback is upgraded to real encryption during rotation', () => {
  // A row written while ENCRYPTION_KEY was unset is reversible by anyone with
  // the database. Rotation is the moment to fix that, not to preserve it.
  const stored = { token: 'b64:' + Buffer.from('sk-was-plaintext').toString('base64') }
  const { value: rotated, upgraded } = rotateCiphertextsDeep(stored, OLD, NEW)
  assert.equal(upgraded, 1)
  const token = (rotated as { token: string }).token
  assert.equal(classifyCiphertext(token), 'v2')
  assert.equal(decryptSecretWithKey(token, NEW), 'sk-was-plaintext')
})

test('a ciphertext that does not open under the old key is left alone and counted as failed', () => {
  // Never destroy a value we cannot read: a partially-rotated table must stay
  // re-runnable, and an unreadable row is an alert, not something to overwrite.
  const foreign = encryptSecretWithKey('unknown', 'some-third-key')
  const { value: rotated, failed } = rotateCiphertextsDeep({ token: foreign }, OLD, NEW)
  assert.equal(failed, 1)
  assert.equal((rotated as { token: string }).token, foreign)
})

test('a value already under the new key is left alone, so rotation is re-runnable', () => {
  const already = encryptSecretWithKey('sk-done', NEW)
  const { value: rotated, rotated: count, failed } = rotateCiphertextsDeep({ token: already }, OLD, NEW)
  assert.equal(count, 0)
  assert.equal(failed, 0)
  assert.equal((rotated as { token: string }).token, already)
})

test('arrays and deep nesting are walked, not just top-level keys', () => {
  const stored = { a: [{ b: { c: encryptSecretWithKey('deep', OLD) } }] }
  const { rotated: count } = rotateCiphertextsDeep(stored, OLD, NEW)
  assert.equal(count, 1)
})

test('counting reports the fallback rows that still need upgrading', () => {
  const stored = {
    good: encryptSecretWithKey('a', OLD),
    bad: 'b64:' + Buffer.from('b').toString('base64'),
    plain: 'hello',
  }
  assert.deepEqual(countCiphertextsDeep(stored), { v2: 1, v1: 0, b64: 1 })
})

test('a v1 row is migrated onto the v2 derivation by rotation', async () => {
  // The reason classifyCiphertext must know about v1 forever: rotation is how
  // rows written under the old derivation move to the new one. A v1 payload
  // that rotation did not recognise would be skipped and reported as success.
  const crypto = await import('node:crypto')
  const key = crypto.createHash('sha256').update(OLD).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const ct = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()])
  const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')

  assert.equal(classifyCiphertext(legacy), 'v1')
  const { value: rotated, rotated: count } = rotateCiphertextsDeep({ token: legacy }, OLD, NEW)
  assert.equal(count, 1)
  const token = (rotated as { token: string }).token
  assert.equal(classifyCiphertext(token), 'v2')
  assert.equal(decryptSecretWithKey(token, NEW), 'legacy')
})
