import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentVisibilityScope, executionVisibilityScope } from '../visibility'

test('workspace content scopes are always owner-only', () => {
  assert.deepEqual(agentVisibilityScope('user-a'), { userId: 'user-a' })
  assert.deepEqual(executionVisibilityScope('user-a'), { userId: 'user-a' })
})
