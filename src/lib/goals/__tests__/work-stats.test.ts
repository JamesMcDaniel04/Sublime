import test from 'node:test'
import assert from 'node:assert/strict'
import { computeWorkStats } from '../work-stats'

const row = (
  resourceId: string,
  disposition: 'pending' | 'used' | 'edited' | 'skipped',
  outcome: 'unknown' | 'worked' | 'no_response' | 'failed' = 'unknown',
) => ({ resourceId, resourceName: `Agent ${resourceId}`, disposition, outcome })

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
