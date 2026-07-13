import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpConnectionScope } from '../tool-catalog'

test('scope without userId fails closed', () => {
  assert.deepEqual(mcpConnectionScope('org1'), { organizationId: 'org1', isActive: true, userId: '__no_user__' })
})

test('scope with userId includes only that user personal rows', () => {
  assert.deepEqual(mcpConnectionScope('org1', 'user1'), {
    organizationId: 'org1',
    isActive: true,
    userId: 'user1',
  })
})
