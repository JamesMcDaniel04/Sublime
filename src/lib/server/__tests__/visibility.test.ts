import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VISIBILITY,
  agentOwnerScope,
  agentReadScope,
  agentVisibilityScope,
  agentWriteScope,
  executionVisibilityScope,
  flowOwnerScope,
  flowReadScope,
  flowVisibilityScope,
  flowWriteScope,
  isVisibility,
} from '../visibility'

const ORG_SHARED = [VISIBILITY.orgViewer, VISIBILITY.orgEditor]

// ── Flows ───────────────────────────────────────────────────────────────────

test('flow READ: owner, invited collaborator, or ANY org share', () => {
  assert.deepEqual(flowReadScope('user-a'), {
    OR: [
      { userId: 'user-a' },
      { collaborators: { some: { userId: 'user-a' } } },
      { visibility: { in: ORG_SHARED } },
    ],
  })
})

test('flow WRITE: org_viewer may NOT edit — only org_editor', () => {
  const scope = flowWriteScope('user-a')
  assert.deepEqual(scope, {
    OR: [
      { userId: 'user-a' },
      { collaborators: { some: { userId: 'user-a' } } },
      { visibility: VISIBILITY.orgEditor },
    ],
  })
  // The whole point of the viewer role: it must not appear in the write scope.
  assert.equal(JSON.stringify(scope).includes(VISIBILITY.orgViewer), false)
})

test('flow OWNER: sharing never grants delete/publish/secrets', () => {
  const scope = flowOwnerScope('user-a')
  assert.deepEqual(scope, { userId: 'user-a' })
  assert.equal(JSON.stringify(scope).includes('visibility'), false, 'no share can satisfy the owner scope')
  assert.equal(JSON.stringify(scope).includes('collaborators'), false, 'not even an invited collaborator')
})

// ── Agents ──────────────────────────────────────────────────────────────────

test('agent READ: owner or any org share', () => {
  assert.deepEqual(agentReadScope('user-a'), { OR: [{ userId: 'user-a' }, { visibility: { in: ORG_SHARED } }] })
})

test('agent WRITE: owner or org_editor only', () => {
  const scope = agentWriteScope('user-a')
  assert.deepEqual(scope, { OR: [{ userId: 'user-a' }, { visibility: VISIBILITY.orgEditor }] })
  assert.equal(JSON.stringify(scope).includes(VISIBILITY.orgViewer), false)
})

test('agent OWNER: owner only', () => {
  assert.deepEqual(agentOwnerScope('user-a'), { userId: 'user-a' })
})

// ── Executions ──────────────────────────────────────────────────────────────

test('run history is NEVER shared by sharing a flow — it can hold other people data', () => {
  assert.deepEqual(executionVisibilityScope('user-a'), { userId: 'user-a' })
})

// ── Deprecated aliases ──────────────────────────────────────────────────────

test('deprecated aliases stay pinned to pre-sharing behavior (no accidental widening)', () => {
  // Any call site not yet migrated must keep its old, restrictive rule.
  assert.deepEqual(agentVisibilityScope('user-a'), { userId: 'user-a' })
  assert.deepEqual(flowVisibilityScope('user-a'), {
    OR: [{ userId: 'user-a' }, { collaborators: { some: { userId: 'user-a' } } }],
  })
  assert.equal(JSON.stringify(agentVisibilityScope('user-a')).includes('visibility'), false)
  assert.equal(JSON.stringify(flowVisibilityScope('user-a')).includes('visibility'), false)
})

test('isVisibility accepts only the three known values', () => {
  assert.equal(isVisibility('private'), true)
  assert.equal(isVisibility('org_viewer'), true)
  assert.equal(isVisibility('org_editor'), true)
  assert.equal(isVisibility('public'), false, 'there is no public sharing')
  assert.equal(isVisibility(undefined), false)
})
