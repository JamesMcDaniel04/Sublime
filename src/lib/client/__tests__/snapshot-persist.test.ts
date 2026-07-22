import '@/test-support/jsdom-env'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testResetSnapshotForReload,
  peekSnapshot,
  primeBootstrap,
  scopeSnapshot,
  subscribeSnapshot,
  type Snapshot,
} from '../snapshot'
import { __testResetForReload, scopeCachedJson } from '../use-cached-json'

const snapshot: Snapshot = {
  success: true,
  agents: [],
  activities: [],
  usage: { since: '2026-07-01T00:00:00.000Z', executions: 0, inputTokens: 0, outputTokens: 0 },
  activeOrganizationId: 'org-1',
  organizations: [{ id: 'org-1', name: 'Workspace', slug: 'workspace', plan: 'pro' }],
  notifications: [],
  unread: 0,
}

beforeEach(() => {
  window.sessionStorage.clear()
  scopeCachedJson(null)
  __testResetForReload()
  __testResetSnapshotForReload()
})

test('bootstrap persists a user-scoped shell snapshot across a hard navigation', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      userId: 'user-1',
      snapshot,
      connectionStatus: { success: true, connections: {} },
      profile: { success: true, profile: { role: 'ADMIN' } },
    }),
  } as Response)) as typeof fetch

  await primeBootstrap('user-1')
  assert.equal(peekSnapshot()?.activeOrganizationId, 'org-1')

  __testResetSnapshotForReload()
  let hydrated: Snapshot | null = null
  const unsubscribe = subscribeSnapshot((value) => { hydrated = value })
  scopeSnapshot('user-1')
  unsubscribe()

  assert.equal((hydrated as Snapshot | null)?.activeOrganizationId, 'org-1')
  assert.equal(peekSnapshot()?.organizations[0]?.name, 'Workspace')
})

test('a different user cannot hydrate the prior user snapshot', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, userId: 'user-1', snapshot, connectionStatus: {}, profile: {} }),
  } as Response)) as typeof fetch
  await primeBootstrap('user-1')

  __testResetSnapshotForReload()
  scopeSnapshot('user-2')
  assert.equal(peekSnapshot(), null)
  assert.equal(window.sessionStorage.getItem('shell-snapshot:v1'), null)
})
