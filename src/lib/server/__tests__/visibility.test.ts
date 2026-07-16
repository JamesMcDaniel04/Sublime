import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VISIBILITY,
  agentOwnerScope,
  agentReadScope,
  agentWriteScope,
  executionVisibilityScope,
  flowOwnerScope,
  flowRunVisibilityScope,
  flowReadScope,
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

test('FLOW run history follows the same invariant: own runs only', () => {
  // A non-owner viewer of a shared flow sees only their own runs.
  assert.deepEqual(flowRunVisibilityScope('user-a', 'owner-b'), { userId: 'user-a' })
  // The flow owner additionally sees ownerless (legacy/system) runs, which
  // would otherwise be invisible to everyone.
  assert.deepEqual(flowRunVisibilityScope('owner-b', 'owner-b'), { OR: [{ userId: 'owner-b' }, { userId: null }] })
  // A null flow owner (legacy row) never widens a viewer's scope.
  assert.deepEqual(flowRunVisibilityScope('user-a', null), { userId: 'user-a' })
})

// ── Deprecated aliases ──────────────────────────────────────────────────────

test('legacy "shared" never grants org access — it must not appear in any scope', () => {
  // Agents used to DEFAULT to visibility:'shared' while the rules ignored it, so
  // treating that value as an org share would expose every pre-existing agent at
  // once. Only the explicit org_* roles may ever widen access.
  for (const scope of [flowReadScope('u'), flowWriteScope('u'), agentReadScope('u'), agentWriteScope('u')]) {
    assert.equal(JSON.stringify(scope).includes('"shared"'), false)
  }
})

test('isVisibility accepts only the three known values', () => {
  assert.equal(isVisibility('private'), true)
  assert.equal(isVisibility('org_viewer'), true)
  assert.equal(isVisibility('org_editor'), true)
  assert.equal(isVisibility('public'), false, 'there is no public sharing')
  assert.equal(isVisibility(undefined), false)
})
