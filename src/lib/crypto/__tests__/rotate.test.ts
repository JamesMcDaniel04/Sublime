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
  assert.equal(classifyCiphertext(encryptSecretWithKey('x', OLD)), 'v1')
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
  assert.equal(classifyCiphertext(token), 'v1')
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
  assert.deepEqual(countCiphertextsDeep(stored), { v1: 1, b64: 1 })
})
