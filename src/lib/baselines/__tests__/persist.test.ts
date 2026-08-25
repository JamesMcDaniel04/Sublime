import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedWindowDays, recomputeOrgBaselines } from '../persist'
import { HANDLING_TIME_MINUTES, HANDLING_TIME_TABLE_VERSION } from '../handling-time'

test('observed window spans the earliest event to now, floored at 1 day', () => {
  const now = new Date('2026-08-03T00:00:00Z')
  assert.equal(observedWindowDays([{ occurredAt: new Date('2026-07-04T00:00:00Z') }], now), 30)
  // Same-day history is one day of coverage, never zero — a zero would make
  // confidence identically zero and hide an otherwise valid low-coverage row.
  assert.equal(observedWindowDays([{ occurredAt: new Date('2026-08-03T00:00:00Z') }], now), 1)
  assert.equal(observedWindowDays([], now), 0)
})

function fakeDb(options: {
  rows: unknown[]
  settings?: unknown
  upserts?: Record<string, unknown>[]
}) {
  return {
    activityEvent: { findMany: async () => options.rows },
    processBaseline: {
      upsert: async (args: Record<string, unknown>) => {
        options.upserts?.push(args)
        return {}
      },
    },
    organization: { findUnique: async () => ({ settings: options.settings ?? {} }) },
  } as never
}

test('recompute upserts one baseline per process with resolved handling minutes', async () => {
  const upserts: Record<string, unknown>[] = []
  const db = fakeDb({
    rows: [
      {
        id: 'evt_1',
        source: 'hubspot',
        action: 'logged_email',
        entityType: 'email',
        entityRef: 'e1',
        actorRef: 'a',
        occurredAt: new Date('2026-07-04T00:00:00Z'),
        previousState: null,
        newState: null,
      },
      {
        id: 'evt_2',
        source: 'hubspot',
        action: 'logged_email',
        entityType: 'email',
        entityRef: 'e2',
        actorRef: 'b',
        occurredAt: new Date('2026-07-20T00:00:00Z'),
        previousState: null,
        newState: null,
      },
    ],
    settings: { handlingTimeOverrides: { logged_email: 9 } },
    upserts,
  })

  const result = await recomputeOrgBaselines('org_1', { now: new Date('2026-08-03T00:00:00Z'), db })
  assert.equal(result.events, 2)
  assert.equal(result.baselines, 1)

  const created = upserts[0].create as Record<string, unknown>
  assert.equal(created.organizationId, 'org_1')
  assert.equal(created.action, 'logged_email')
  assert.equal(created.volume, 2)
  assert.equal(created.windowDays, 30)
  // The org override wins over the curated 4.
  assert.equal(created.handlingMinutes, 9)
  assert.notEqual(created.handlingMinutes, HANDLING_TIME_MINUTES.logged_email)
  assert.equal(created.handlingTimeTableVersion, HANDLING_TIME_TABLE_VERSION)
})

test('an action outside the curated table persists with null handling minutes', async () => {
  const upserts: Record<string, unknown>[] = []
  const db = fakeDb({
    rows: [
      {
        id: 'evt_1',
        source: 'asana',
        action: 'invented_action',
        entityType: 'thing',
        entityRef: 't1',
        actorRef: 'a',
        occurredAt: new Date('2026-07-04T00:00:00Z'),
        previousState: null,
        newState: null,
      },
    ],
    upserts,
  })

  await recomputeOrgBaselines('org_3', { now: new Date('2026-08-03T00:00:00Z'), db })
  const created = upserts[0].create as Record<string, unknown>
  // No fabricated estimate for an action nobody has costed.
  assert.equal(created.handlingMinutes, null)
  assert.equal(created.volume, 1)
})

test('an org with no activity writes nothing', async () => {
  let upsertCalls = 0
  const db = {
    activityEvent: { findMany: async () => [] },
    processBaseline: {
      upsert: async () => {
        upsertCalls += 1
        return {}
      },
    },
    organization: { findUnique: async () => ({ settings: {} }) },
  } as never

  const result = await recomputeOrgBaselines('org_2', { now: new Date('2026-08-03T00:00:00Z'), db })
  assert.deepEqual(result, { baselines: 0, events: 0 })
  assert.equal(upsertCalls, 0)
})
