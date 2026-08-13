import { test } from 'node:test'
import assert from 'node:assert/strict'

import { connectionAuditDetail } from '../audit'

test('detail carries the plane and provider that identify the grant', () => {
  const detail = connectionAuditDetail({ plane: 'google', provider: 'google-calendar' })
  assert.equal(detail.plane, 'google')
  assert.equal(detail.provider, 'google-calendar')
})

test('scopes are deduped and sorted so two grants of the same access compare equal', () => {
  const detail = connectionAuditDetail({
    plane: 'google',
    provider: 'google-calendar',
    scopes: ['b/scope', 'a/scope', 'b/scope'],
  })
  assert.deepEqual(detail.scopes, ['a/scope', 'b/scope'])
})

test('empty scopes and blank account label are omitted rather than stored as noise', () => {
  const detail = connectionAuditDetail({
    plane: 'mcp',
    provider: 'custom',
    scopes: [],
    accountLabel: '   ',
  })
  assert.equal('scopes' in detail, false)
  assert.equal('accountLabel' in detail, false)
})

test('account label identifies WHICH account was connected', () => {
  const detail = connectionAuditDetail({ plane: 'google', provider: 'google-mail', accountLabel: 'ops@acme.co' })
  assert.equal(detail.accountLabel, 'ops@acme.co')
})

test('a credential-named extra key never reaches the audit row', () => {
  const detail = connectionAuditDetail({
    plane: 'mcp',
    provider: 'custom',
    extra: { serverUrl: 'https://mcp.acme.co', apiKey: 'sk-live-leak', refresh_token: 'rt-leak' },
  })
  assert.equal(detail.serverUrl, 'https://mcp.acme.co')
  assert.equal('apiKey' in detail, false)
  assert.equal('refresh_token' in detail, false)
})

test('a non-scalar extra value is dropped so an authConfig blob cannot be logged wholesale', () => {
  const detail = connectionAuditDetail({
    plane: 'mcp',
    provider: 'custom',
    extra: { authConfig: { clientSecret: 'leak' }, authType: 'oauth2' },
  })
  assert.equal('authConfig' in detail, false)
  assert.equal(detail.authType, 'oauth2')
})

test('extra cannot overwrite the plane the caller declared', () => {
  const detail = connectionAuditDetail({
    plane: 'google',
    provider: 'google-mail',
    extra: { plane: 'spoofed' },
  })
  assert.equal(detail.plane, 'google')
})
