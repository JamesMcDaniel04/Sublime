import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runIncrementalSync, sweepIncrementalSync, sweepSources } from '@/lib/activity/incremental-sync'
import type { ActivitySource } from '@/lib/activity/types'

const HOUR_MS = 60 * 60 * 1000

function fakeSource(name: string, calls: Array<{ source: string; connectionRef: string; since: Date }>): ActivitySource {
  return {
    source: name,
    capabilities: { backfill: false, incrementalSync: true, webhooks: false },
    // Returning no events keeps ingestActivity a no-op, so orchestration is
    // testable without a database behind the global prisma client.
    incrementalSync: async ({ connectionRef }: { connectionRef: string }, since: Date) => {
      calls.push({ source: name, connectionRef, since })
      return []
    },
  } as unknown as ActivitySource
}

function fakeDb(overrides: {
  connections?: Array<{ connectionId: string; providerConfigKey: string; organizationId?: string }>
  latestEventAt?: Date | null
  granolaSecret?: boolean
}) {
  return {
    nangoConnection: {
      findMany: async () => overrides.connections ?? [],
    },
    activityEvent: {
      findFirst: async () =>
        overrides.latestEventAt ? { occurredAt: overrides.latestEventAt } : null,
    },
    integrationSecret: {
      findMany: async () => (overrides.granolaSecret ? [{ id: 'sec1', organizationId: 'org1', userId: 'user1' }] : []),
      findFirst: async () => (overrides.granolaSecret ? { id: 'sec1' } : null),
    },
  }
}

test('sweepSources: incremental-capable, webhook-less sources only (slack excluded)', () => {
  const sources = sweepSources()
  assert.ok(sources.includes('github'))
  assert.ok(sources.includes('google_calendar'))
  assert.ok(sources.includes('hubspot'))
  assert.ok(!sources.includes('slack'))
})

test('since = latest ledger event minus 1h overlap when events exist', async () => {
  const calls: Array<{ source: string; connectionRef: string; since: Date }> = []
  const latest = new Date('2026-08-05T12:00:00Z')
  const db = fakeDb({
    connections: [{ connectionId: 'c1', providerConfigKey: 'github' }],
    latestEventAt: latest,
  })
  await runIncrementalSync('org1', db as never, [fakeSource('github', calls)])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].connectionRef, 'c1')
  assert.equal(calls[0].since.getTime(), latest.getTime() - HOUR_MS)
})

test('first run (empty ledger) uses the 7-day floor', async () => {
  const calls: Array<{ source: string; connectionRef: string; since: Date }> = []
  const db = fakeDb({
    connections: [{ connectionId: 'c1', providerConfigKey: 'github' }],
    latestEventAt: null,
  })
  const before = Date.now()
  await runIncrementalSync('org1', db as never, [fakeSource('github', calls)])
  const after = Date.now()
  assert.equal(calls.length, 1)
  const sevenDays = 7 * 24 * HOUR_MS
  assert.ok(calls[0].since.getTime() >= before - sevenDays)
  assert.ok(calls[0].since.getTime() <= after - sevenDays)
})

test('connections for non-sweep sources are skipped', async () => {
  const calls: Array<{ source: string; connectionRef: string; since: Date }> = []
  const db = fakeDb({
    connections: [
      { connectionId: 'c1', providerConfigKey: 'slack' },
      { connectionId: 'c2', providerConfigKey: 'github' },
    ],
  })
  const slackLike = fakeSource('slack', calls)
  ;(slackLike.capabilities as { webhooks: boolean }).webhooks = true
  await runIncrementalSync('org1', db as never, [slackLike, fakeSource('github', calls)])
  assert.deepEqual(calls.map((call) => call.source), ['github'])
})

test('granola participates via its user-owned IntegrationSecret id', async () => {
  const calls: Array<{ source: string; connectionRef: string; since: Date }> = []
  const db = fakeDb({ granolaSecret: true })
  await runIncrementalSync('org1', db as never, [fakeSource('granola', calls)])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].connectionRef, 'sec1')
})

test('sweep enumerates orgs holding eligible connections and syncs each once', async () => {
  const calls: Array<{ source: string; connectionRef: string; since: Date }> = []
  const db = {
    nangoConnection: {
      findMany: async (query: { select?: Record<string, boolean> }) =>
        query.select?.organizationId
          ? [
              { organizationId: 'org1', providerConfigKey: 'github' },
              { organizationId: 'org1', providerConfigKey: 'github' },
              { organizationId: 'org2', providerConfigKey: 'slack' },
            ]
          : [{ connectionId: 'c1', providerConfigKey: 'github' }],
    },
    activityEvent: { findFirst: async () => null },
    integrationSecret: { findMany: async () => [], findFirst: async () => null },
  }
  await sweepIncrementalSync(db as never, [fakeSource('github', calls)])
  // org2 holds only a webhook source, so exactly org1's connection syncs.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].connectionRef, 'c1')
})
