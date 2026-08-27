import test from 'node:test'
import assert from 'node:assert/strict'
import { containsSecretKey, installRequiresSecret, parseDefinition, slugify, snapshotDefinition, updateAvailable } from '../listing'

const native = { description: 'Renewal Scout', objective: 'Monitor renewal risk.', goal: 'Retain accounts', metadata: { title: 'Riley', model: 'claude-sonnet-5', integrations: ['slack', 'salesforce'], outputFields: [], skills: ['sk_1'], httpTools: [{ name: 'x', url: 'https://…', authRef: 'cred_1' }] }, grants: { '*': 'read', slack: 'write' }, runtime: 'native' }

test('a native snapshot carries the job, not the workspace-local plumbing', () => {
  const def = snapshotDefinition(native, null)
  assert.equal(def.kind, 'native')
  if (def.kind !== 'native') throw new Error()
  assert.equal(def.native.title, 'Riley')
  assert.equal(def.native.instructions, 'Monitor renewal risk.')
  assert.deepEqual(def.native.integrations, ['slack', 'salesforce'])
  assert.deepEqual(def.native.grants, { '*': 'read', slack: 'write' })
  // Skills and HTTP endpoints reference vault rows in the publisher's workspace — dropped.
  assert.equal(JSON.stringify(def).includes('sk_1'), false)
  assert.equal(JSON.stringify(def).includes('cred_1'), false)
})

test('an external snapshot names the endpoint and header, never the secret', () => {
  const def = snapshotDefinition({ ...native, runtime: 'external' }, { endpointUrl: 'https://agents.example.com/run', authType: 'header', authConfig: { headerName: 'X-Key', secretEnc: 'ciphertext' }, timeoutMinutes: 15 })
  if (def.kind !== 'external') throw new Error()
  assert.equal(def.external.endpointUrl, 'https://agents.example.com/run')
  assert.equal(def.external.headerName, 'X-Key')
  assert.equal(def.external.timeoutMinutes, 15)
  assert.equal(JSON.stringify(def).includes('ciphertext'), false)
  assert.equal(containsSecretKey(def), false, 'the invariant the routes assert before storing')
})

test('an external agent with no binding cannot be published', () => {
  assert.throws(() => snapshotDefinition({ ...native, runtime: 'external' }, null), /no endpoint/)
})

test('a stored definition round-trips, and junk is refused', () => {
  const def = snapshotDefinition(native, null)
  assert.deepEqual(parseDefinition(JSON.parse(JSON.stringify(def))), def)
  assert.equal(parseDefinition({ kind: 'native', native: { title: 'x' } }), null, 'no instructions')
  assert.equal(parseDefinition({ kind: 'external', external: { title: 'x', objective: 'o' } }), null, 'no endpoint')
  assert.equal(parseDefinition('nope'), null)
})

test('only an authenticated external listing needs the installer to bring a credential', () => {
  assert.equal(installRequiresSecret(snapshotDefinition(native, null)), false)
  assert.equal(installRequiresSecret(snapshotDefinition({ ...native, runtime: 'external' }, { endpointUrl: 'https://x', authType: 'none', authConfig: {}, timeoutMinutes: 10 })), false)
  assert.equal(installRequiresSecret(snapshotDefinition({ ...native, runtime: 'external' }, { endpointUrl: 'https://x', authType: 'bearer', authConfig: {}, timeoutMinutes: 10 })), true)
})

test('slugs and versions', () => {
  assert.equal(slugify('Renewal Scout (v2)!'), 'renewal-scout-v2')
  assert.equal(slugify('   '), 'agent')
  assert.equal(updateAvailable(1, 2), true); assert.equal(updateAvailable(2, 2), false)
})

test('containsSecretKey catches the shapes a snapshot must never hold', () => {
  assert.equal(containsSecretKey({ a: { secretEnc: 'x' } }), true)
  assert.equal(containsSecretKey({ authConfig: { apiToken: 'x' } }), true)
  assert.equal(containsSecretKey({ headerName: 'X-Key', endpointUrl: 'https://x' }), false)
})
