import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveHttpAuthRef } from '../http-auth-ref'

test('an explicit generic mode authenticates with the vault credential', () => {
  assert.deepEqual(
    resolveHttpAuthRef({ authMode: 'generic', credentialId: 'cred_1', connectionId: 'conn_1' }),
    { kind: 'credential', credentialId: 'cred_1' },
  )
})

test('an explicit predefined mode authenticates with the connection', () => {
  assert.deepEqual(
    resolveHttpAuthRef({ authMode: 'predefined', credentialId: 'cred_1', connectionId: 'conn_1' }),
    { kind: 'connection', connectionId: 'conn_1' },
  )
})

test('authMode none authenticates with nothing, whatever fields are left over', () => {
  assert.deepEqual(
    resolveHttpAuthRef({ authMode: 'none', credentialId: 'cred_1', connectionId: 'conn_1' }),
    { kind: 'none' },
  )
})

test('a pre-vault graph with only a credential infers the vault credential', () => {
  assert.deepEqual(resolveHttpAuthRef({ credentialId: 'cred_1' }), { kind: 'credential', credentialId: 'cred_1' })
})

test('a pre-vault graph with both fields prefers the connection, preserving legacy behaviour', () => {
  assert.deepEqual(
    resolveHttpAuthRef({ credentialId: 'cred_1', connectionId: 'conn_1' }),
    { kind: 'connection', connectionId: 'conn_1' },
  )
})

test('whitespace-only ids do not count as configured auth', () => {
  assert.deepEqual(resolveHttpAuthRef({ authMode: 'generic', credentialId: '   ' }), { kind: 'none' })
})

test('generic mode with no credential falls through to nothing rather than to the connection', () => {
  // The node explicitly says "use a vault credential"; silently authenticating
  // with a leftover connection would send a DIFFERENT identity than authored.
  assert.deepEqual(resolveHttpAuthRef({ authMode: 'generic', connectionId: 'conn_1' }), { kind: 'none' })
})

test('non-string fields are treated as absent rather than coerced', () => {
  assert.deepEqual(
    resolveHttpAuthRef({ credentialId: 42 as unknown as string, connectionId: null as unknown as string }),
    { kind: 'none' },
  )
})
