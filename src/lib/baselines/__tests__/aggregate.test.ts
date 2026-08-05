import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByProcess, median, processKeyOf, volumeStats } from '../aggregate'
import type { BaselineEvent } from '../types'

const at = (iso: string): Date => new Date(iso)

function event(overrides: Partial<BaselineEvent> = {}): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'logged_email',
    entityType: 'email',
    entityRef: 'e1',
    actorRef: 'owner_7',
    occurredAt: at('2026-07-01T00:00:00Z'),
    previousState: null,
    newState: null,
    ...overrides,
  }
}

test('median handles odd, even, and empty', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
})

test('groups by source, action, and entityType', () => {
  const groups = groupByProcess([
    event(),
    event({ entityRef: 'e2' }),
    event({ action: 'logged_call', entityType: 'call', entityRef: 'c1' }),
    event({ source: 'github', action: 'opened_pr', entityType: 'pull_request', entityRef: 'r#1' }),
  ])
  assert.equal(groups.size, 3)
  assert.equal(groups.get('hubspot|logged_email|email')?.length, 2)
  assert.equal(groups.get('hubspot|logged_call|call')?.length, 1)
  assert.equal(
    processKeyOf({ source: 'github', action: 'opened_pr', entityType: 'pull_request' }),
    'github|opened_pr|pull_request',
  )
})

test('volume counts events, actors are distinct, period is the median gap in days', () => {
  const stats = volumeStats([
    event({ entityRef: 'e1', occurredAt: at('2026-07-01T00:00:00Z'), actorRef: 'a' }),
    event({ entityRef: 'e2', occurredAt: at('2026-07-03T00:00:00Z'), actorRef: 'b' }),
    event({ entityRef: 'e3', occurredAt: at('2026-07-04T00:00:00Z'), actorRef: 'a' }),
  ])
  assert.equal(stats.volume, 3)
  assert.equal(stats.distinctActors, 2)
  // Gaps are 2d and 1d; median 1.5.
  assert.equal(stats.periodDays, 1.5)
})

test('a single event has volume but no period', () => {
  const stats = volumeStats([event()])
  assert.equal(stats.volume, 1)
  assert.equal(stats.distinctActors, 1)
  assert.equal(stats.periodDays, null)
})

test('unsorted input still yields the correct period', () => {
  const stats = volumeStats([
    event({ entityRef: 'e3', occurredAt: at('2026-07-04T00:00:00Z') }),
    event({ entityRef: 'e1', occurredAt: at('2026-07-01T00:00:00Z') }),
    event({ entityRef: 'e2', occurredAt: at('2026-07-03T00:00:00Z') }),
  ])
  assert.equal(stats.periodDays, 1.5)
})

test('median resists the outlier that would wreck a mean', () => {
  // One deal sitting untouched for a year must not define the org's cadence.
  const stats = volumeStats([
    event({ entityRef: 'e1', occurredAt: at('2026-07-01T00:00:00Z') }),
    event({ entityRef: 'e2', occurredAt: at('2026-07-02T00:00:00Z') }),
    event({ entityRef: 'e3', occurredAt: at('2026-07-03T00:00:00Z') }),
    event({ entityRef: 'e4', occurredAt: at('2027-07-03T00:00:00Z') }),
  ])
  assert.equal(stats.periodDays, 1)
})

test('an empty group has no volume, no actors, and no period', () => {
  assert.deepEqual(volumeStats([]), { volume: 0, distinctActors: 0, periodDays: null })
  assert.equal(groupByProcess([]).size, 0)
})
