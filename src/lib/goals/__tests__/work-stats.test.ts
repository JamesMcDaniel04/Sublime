import test from 'node:test'
import assert from 'node:assert/strict'
import { computeWorkStats } from '../work-stats'

const row = (
  resourceId: string,
  disposition: 'pending' | 'used' | 'edited' | 'skipped',
  outcome: 'unknown' | 'worked' | 'no_response' | 'failed' = 'unknown',
) => ({ resourceId, resourceName: `Agent ${resourceId}`, assigneeUserId: null, assigneeName: 'Unassigned', disposition, outcome })

test('an empty ledger produces zeros and null rates, never NaN', () => {
  const stats = computeWorkStats([])
  assert.deepEqual(stats.overall, {
    produced: 0,
    used: 0,
    worked: 0,
    usedRate: null,
    workedRate: null,
  })
  assert.deepEqual(stats.byAgent, [])
})

test('used counts both used and edited', () => {
  const stats = computeWorkStats([row('a', 'used'), row('a', 'edited'), row('a', 'pending')])
  assert.equal(stats.overall.produced, 3)
  assert.equal(stats.overall.used, 2)
})

test('skipped items count as produced but are excluded from the outcome denominator', () => {
  // A high skip rate must read as a targeting problem, not disappear.
  const stats = computeWorkStats([
    row('a', 'used', 'worked'),
    row('a', 'used', 'no_response'),
    row('a', 'skipped'),
    row('a', 'skipped'),
  ])
  assert.equal(stats.overall.produced, 4, 'skipped work was still produced')
  assert.equal(stats.overall.used, 2)
  assert.equal(stats.overall.worked, 1)
  assert.equal(stats.overall.usedRate, 0.5, 'used / produced')
  assert.equal(stats.overall.workedRate, 0.5, 'worked / used, NOT worked / produced')
})

test('workedRate is null when nothing has been used yet', () => {
  const stats = computeWorkStats([row('a', 'pending'), row('a', 'skipped')])
  assert.equal(stats.overall.usedRate, 0)
  assert.equal(stats.overall.workedRate, null, 'no denominator, so no rate')
})

test('per-agent rows carry their own funnel and sort by produced descending', () => {
  const stats = computeWorkStats([
    row('quiet', 'used', 'worked'),
    row('busy', 'used', 'worked'),
    row('busy', 'used', 'no_response'),
    row('busy', 'skipped'),
  ])
  assert.equal(stats.byAgent.length, 2)
  assert.equal(stats.byAgent[0].resourceId, 'busy', 'busiest agent first')
  assert.equal(stats.byAgent[0].produced, 3)
  assert.equal(stats.byAgent[0].used, 2)
  assert.equal(stats.byAgent[0].worked, 1)
  assert.equal(stats.byAgent[1].resourceId, 'quiet')
  assert.equal(stats.byAgent[1].workedRate, 1)
})

test('only `worked` counts as worked — no_response and failed do not', () => {
  const stats = computeWorkStats([
    row('a', 'used', 'no_response'),
    row('a', 'used', 'failed'),
    row('a', 'used', 'unknown'),
  ])
  assert.equal(stats.overall.worked, 0)
})

test('an outcome on a skipped row cannot inflate worked', () => {
  // The route refuses this transition, but the funnel must not depend on that
  // to stay honest — a row that reached this state some other way is ignored.
  const stats = computeWorkStats([row('a', 'skipped', 'worked')])
  assert.equal(stats.overall.worked, 0)
  assert.equal(stats.overall.used, 0)
})

const forRep = (
  assigneeUserId: string | null,
  assigneeName: string,
  disposition: 'pending' | 'used' | 'edited' | 'skipped',
  outcome: 'unknown' | 'worked' | 'no_response' | 'failed' = 'unknown',
) => ({ resourceId: 'a', resourceName: 'Agent a', assigneeUserId, assigneeName, disposition, outcome })

test('adoption buckets by the person, with the same funnel math as by agent', () => {
  const stats = computeWorkStats([
    forRep('u1', 'Dana Reed', 'used', 'worked'),
    forRep('u1', 'Dana Reed', 'used'),
    forRep('u2', 'Sam Diaz', 'used'),
    forRep('u2', 'Sam Diaz', 'skipped'),
  ])
  const dana = stats.byAssignee.find((row) => row.assigneeUserId === 'u1')!
  assert.equal(dana.produced, 2)
  assert.equal(dana.used, 2)
  assert.equal(dana.usedRate, 1)
  assert.equal(dana.worked, 1)
  assert.equal(stats.overall.produced, stats.byAssignee.reduce((sum, row) => sum + row.produced, 0))
})

test('unassigned work is its own bucket and always sorts last', () => {
  // Work nobody owns does not get done — a routing finding, not a rep finding,
  // so it must never head the list as though it were a person.
  const stats = computeWorkStats([
    forRep(null, 'Unassigned', 'pending'),
    forRep(null, 'Unassigned', 'pending'),
    forRep(null, 'Unassigned', 'pending'),
    forRep('u1', 'Dana Reed', 'used'),
  ])
  assert.equal(stats.byAssignee.at(-1)!.assigneeUserId, null)
  assert.equal(stats.byAssignee.at(-1)!.produced, 3)
})

test('reps sort by volume, never by rate — the list is not a leaderboard', () => {
  const stats = computeWorkStats([
    forRep('quiet', 'Quiet Rep', 'used'),
    forRep('busy', 'Busy Rep', 'used'),
    forRep('busy', 'Busy Rep', 'skipped'),
    forRep('busy', 'Busy Rep', 'skipped'),
  ])
  assert.deepEqual(
    stats.byAssignee.map((row) => row.assigneeUserId),
    ['busy', 'quiet'],
    'the rep with the most work comes first, despite the worse rate',
  )
})

test('byAgent is unchanged by the new bucket', () => {
  const stats = computeWorkStats([
    forRep('u1', 'Dana Reed', 'used'),
    forRep('u2', 'Sam Diaz', 'skipped'),
  ])
  assert.equal(stats.byAgent.length, 1, 'both rows came from the same agent')
  assert.equal(stats.byAgent[0].produced, 2)
})
