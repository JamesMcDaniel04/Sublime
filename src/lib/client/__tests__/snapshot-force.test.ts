/**
 * Forced snapshot reads (getSnapshot(0), used right after a mutation) must
 * observe the mutation:
 *  1. they must NOT reuse an in-flight request that started before the write;
 *  2. a slow pre-write response resolving later must NOT overwrite the
 *     forced result (the "zombie agent" repaint behind the dead delete button).
 */
import '@/test-support/jsdom-env'
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testResetSnapshotForReload,
  getSnapshot,
  peekSnapshot,
  primeBootstrap,
  type Snapshot,
} from '../snapshot'
import { __testResetForReload, scopeCachedJson } from '../use-cached-json'

const snapshotWith = (agentIds: string[]): Snapshot => ({
  success: true,
  agents: agentIds.map((id) => ({ id, title: id })) as unknown as Snapshot['agents'],
  activities: [],
  usage: { since: '2026-07-01T00:00:00.000Z', executions: 0, inputTokens: 0, outputTokens: 0 },
  activeOrganizationId: 'org-1',
  organizations: [{ id: 'org-1', name: 'Workspace', slug: 'workspace', plan: 'pro' }],
  notifications: [],
  unread: 0,
})

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response

beforeEach(async () => {
  window.sessionStorage.clear()
  scopeCachedJson(null)
  __testResetForReload()
  __testResetSnapshotForReload()
  // Bootstrap once so subsequent getSnapshot() calls hit /api/snapshot.
  globalThis.fetch = (async () =>
    jsonResponse({
      success: true,
      userId: 'user-1',
      snapshot: snapshotWith(['agent-doomed']),
      connectionStatus: { success: true, connections: {} },
      profile: { success: true, profile: {} },
    })) as typeof fetch
  await primeBootstrap('user-1')
})

test('a forced read does not reuse a request that predates the mutation, and a late stale response cannot overwrite it', async () => {
  // Request #1 (poller): started BEFORE the delete; resolves LAST, still
  // carrying the doomed agent. Request #2 (forced, post-delete): resolves
  // first, without it.
  let resolveStale: (value: Response) => void = () => {}
  const stale = new Promise<Response>((resolve) => { resolveStale = resolve })
  let call = 0
  globalThis.fetch = (async () => {
    call += 1
    if (call === 1) return stale
    return jsonResponse(snapshotWith([]))
  }) as typeof fetch

  await new Promise((resolve) => setTimeout(resolve, 5)) // age the cache past the poller's freshness window
  const pollerRead = getSnapshot(1) // cache older than 1ms → dedupe path starts request #1
  const forcedPromise = getSnapshot(0) // post-mutation read — must be request #2
  // Under the bug the forced read is chained to request #1 (which hasn't
  // resolved), so it cannot settle — detect that with a short race instead
  // of hanging the suite.
  const winner = await Promise.race([
    forcedPromise.then(() => 'resolved' as const),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ])
  assert.equal(winner, 'resolved', 'forced read must not be blocked behind the pre-mutation request')
  const forcedRead = await forcedPromise
  assert.equal(forcedRead.agents.length, 0, 'forced read must observe the delete, not reuse the older request')

  // The slow pre-delete response lands afterwards — it must not resurrect the agent.
  resolveStale(jsonResponse(snapshotWith(['agent-doomed'])))
  await pollerRead
  assert.equal(peekSnapshot()?.agents.length, 0, 'a late stale response must not overwrite a newer applied snapshot')
})
