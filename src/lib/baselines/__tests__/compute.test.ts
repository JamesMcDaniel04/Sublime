import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBaseline, computeBaselines, confidenceOf, MIN_MEASURED_CONFIDENCE } from '../compute'
import type { BaselineEvent } from '../types'

function emailAt(entityRef: string, iso: string, actorRef = 'owner_7'): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'logged_email',
    entityType: 'email',
    entityRef,
    actorRef,
    occurredAt: new Date(iso),
    previousState: null,
    newState: null,
  }
}

test('confidence rises with volume and window coverage, capped at 1', () => {
  assert.equal(confidenceOf({ volume: 0, windowDays: 90 }), 0)
  // 15 of 30 events, full coverage.
  assert.equal(confidenceOf({ volume: 15, windowDays: 30 }), 0.5)
  // Full volume but half the coverage.
  assert.equal(confidenceOf({ volume: 30, windowDays: 15 }), 0.5)
  assert.equal(confidenceOf({ volume: 300, windowDays: 900 }), 1)
})

test('the measured floor is reachable with a month of modest volume', () => {
  assert.ok(confidenceOf({ volume: 12, windowDays: 30 }) >= MIN_MEASURED_CONFIDENCE)
  assert.ok(confidenceOf({ volume: 3, windowDays: 30 }) < MIN_MEASURED_CONFIDENCE)
})

test('a burst with no history scores low even at high volume', () => {
  // 200 events across 3 days is a backfill burst, not an established cadence.
  assert.ok(confidenceOf({ volume: 200, windowDays: 3 }) < MIN_MEASURED_CONFIDENCE)
})

test('a baseline carries measured stats and its window', () => {
  const events = [
    emailAt('e1', '2026-07-01T00:00:00Z'),
    emailAt('e2', '2026-07-03T00:00:00Z', 'owner_8'),
    emailAt('e3', '2026-07-04T00:00:00Z'),
  ]
  const baseline = computeBaseline(events, 30)
  assert.ok(baseline)
  assert.equal(baseline.source, 'hubspot')
  assert.equal(baseline.action, 'logged_email')
  assert.equal(baseline.entityType, 'email')
  assert.equal(baseline.volume, 3)
  assert.equal(baseline.distinctActors, 2)
  assert.equal(baseline.periodDays, 1.5)
  assert.equal(baseline.windowDays, 30)
  // Point events cannot yield duration or rework.
  assert.equal(baseline.medianCycleTimeHours, null)
  assert.equal(baseline.reworkRate, null)
})

test('an empty group yields no baseline', () => {
  assert.equal(computeBaseline([], 30), null)
})

test('computeBaselines produces one baseline per process, sorted by confidence', () => {
  const events: BaselineEvent[] = [
    emailAt('e1', '2026-07-01T00:00:00Z'),
    emailAt('e2', '2026-07-02T00:00:00Z'),
    emailAt('e3', '2026-07-03T00:00:00Z'),
    {
      source: 'github',
      action: 'opened_pr',
      entityType: 'pull_request',
      entityRef: 'acme/api#1',
      actorRef: 'alice',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      previousState: null,
      newState: null,
    },
  ]
  const baselines = computeBaselines(events, 30)
  assert.equal(baselines.length, 2)
  // Highest confidence first — the caller's cutoff work is then a prefix.
  assert.ok(baselines[0].confidence >= baselines[1].confidence)
  assert.equal(baselines[0].action, 'logged_email')
})

test('a transition-bearing process reports cycle time and rework end to end', () => {
  const stage = (entityRef: string, from: string, to: string, iso: string): BaselineEvent => ({
    source: 'hubspot',
    action: 'deal_stage_changed',
    entityType: 'deal',
    entityRef,
    actorRef: 'owner_7',
    occurredAt: new Date(iso),
    previousState: { stage: from },
    newState: { stage: to },
  })
  const baseline = computeBaseline(
    [
      stage('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
      stage('d1', 'qualified', 'proposal', '2026-07-02T00:00:00Z'),
      stage('d1', 'proposal', 'qualified', '2026-07-03T00:00:00Z'),
    ],
    30,
  )
  assert.ok(baseline)
  assert.equal(baseline.medianCycleTimeHours, 24)
  assert.equal(baseline.reworkRate, 1)
})
