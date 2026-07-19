import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyForConnection } from '../proxy'

test('native connections get the google proxy, others fall through', () => {
  assert.equal(
    typeof proxyForConnection({ connectionId: 'c1', providerConfigKey: 'google-mail', scope: 'user', provider: 'google-native', organizationId: 'o1' }),
    'function',
  )
  assert.equal(
    proxyForConnection({ connectionId: 'c2', providerConfigKey: 'google-mail', scope: 'user', provider: null, organizationId: 'o1' }),
    undefined,
  )
  assert.equal(
    proxyForConnection({ connectionId: 'c3', providerConfigKey: 'slack', scope: 'org', provider: 'slack', organizationId: 'o1' }),
    undefined,
  )
})
