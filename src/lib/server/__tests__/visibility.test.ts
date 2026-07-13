import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentVisibilityScope, executionVisibilityScope, flowVisibilityScope } from '../visibility'

test('agents and flows are always scoped to their creator', () => {
  assert.deepEqual(agentVisibilityScope('user-a'), { userId: 'user-a' })
})

test('flows are visible only to their owner or explicit Jam collaborators', () => {
  assert.deepEqual(flowVisibilityScope('user-a'), {
    OR: [
      { userId: 'user-a' },
      { collaborators: { some: { userId: 'user-a' } } },
    ],
  })
})

test('agent and template executions are always scoped to the acting user', () => {
  assert.deepEqual(executionVisibilityScope('user-a'), { userId: 'user-a' })
})
