import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpConnectionScope } from '../tool-catalog'

test('scope without userId matches platform-managed org rows only', () => {
  assert.deepEqual(mcpConnectionScope('org1'), {
    organizationId: 'org1', isActive: true, userId: null, provider: { not: null },
  })
})

test('scope with userId includes platform-managed and own personal rows', () => {
  assert.deepEqual(mcpConnectionScope('org1', 'user1'), {
    organizationId: 'org1',
    isActive: true,
    OR: [{ userId: 'user1' }, { userId: null, provider: { not: null } }],
  })
})
