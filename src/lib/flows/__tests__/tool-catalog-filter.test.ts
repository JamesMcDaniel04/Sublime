import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpConnectionScope } from '../tool-catalog'

test('scope without userId matches org-shared rows only semantics (no OR clause)', () => {
  assert.deepEqual(mcpConnectionScope('org1'), { organizationId: 'org1', isActive: true })
})

test('scope with userId includes org-shared and own personal rows', () => {
  assert.deepEqual(mcpConnectionScope('org1', 'user1'), {
    organizationId: 'org1',
    isActive: true,
    OR: [{ userId: null }, { userId: 'user1' }],
  })
})
