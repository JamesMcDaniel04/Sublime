import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentVisibilityScope, executionVisibilityScope, flowVisibilityScope } from '../visibility'

test('workspace content scopes are always owner-only', () => {
  assert.deepEqual(agentVisibilityScope('user-a'), { userId: 'user-a' })
  assert.deepEqual(executionVisibilityScope('user-a'), { userId: 'user-a' })
})

test('flow scope allows only the owner or an explicitly invited collaborator', () => {
  assert.deepEqual(flowVisibilityScope('user-a'), {
    OR: [
      { userId: 'user-a' },
      { collaborators: { some: { userId: 'user-a' } } },
    ],
  })
})
