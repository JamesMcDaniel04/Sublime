import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTransitions, medianCycleTimeHours, reworkRate } from '../transitions'
import type { BaselineEvent } from '../types'

function transition(entityRef: string, from: string, to: string, iso: string): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'deal_stage_changed',
    entityType: 'deal',
    entityRef,
    actorRef: 'owner_7',
    occurredAt: new Date(iso),
    previousState: { stage: from },
    newState: { stage: to },
  }
}

const pointEvent: BaselineEvent = {
  source: 'hubspot',
  action: 'logged_email',
  entityType: 'email',
  entityRef: 'e1',
  actorRef: 'owner_7',
  occurredAt: new Date('2026-07-01T00:00:00Z'),
  previousState: null,
  newState: null,
}

test('transitions are detected by the presence of previousState', () => {
  assert.equal(hasTransitions([transition('d1', 'a', 'b', '2026-07-01T00:00:00Z')]), true)
  assert.equal(hasTransitions([pointEvent]), false)
})

test("cycle time is the median gap between an entity's consecutive transitions", () => {
  const events = [
    transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d1', 'qualified', 'proposal', '2026-07-03T00:00:00Z'), // 48h
    transition('d2', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d2', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'), // 24h
  ]
  // Gaps are 48h and 24h; median 36.
  assert.equal(medianCycleTimeHours(events), 36)
})

test('cycle time is null without transitions or without a second event per entity', () => {
  assert.equal(medianCycleTimeHours([pointEvent]), null)
  assert.equal(medianCycleTimeHours([transition('d1', 'a', 'b', '2026-07-01T00:00:00Z')]), null)
})

test('cycle time sorts per entity, so out-of-order input never yields a negative gap', () => {
  const events = [
    transition('d1', 'qualified', 'proposal', '2026-07-03T00:00:00Z'),
    transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
  ]
  assert.equal(medianCycleTimeHours(events), 48)
})

test('rework counts entities re-entering a state they previously left', () => {
  const events = [
    // d1 goes forward then back into qualified — rework.
    transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d1', 'qualified', 'proposal', '2026-07-02T00:00:00Z'),
    transition('d1', 'proposal', 'qualified', '2026-07-03T00:00:00Z'),
    // d2 only moves forward.
    transition('d2', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d2', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'),
  ]
  assert.equal(reworkRate(events), 0.5)
})

test('rework is null when nothing transitions, zero when nothing regresses', () => {
  // Null and 0 are different claims: "unmeasurable" vs "measured, none found".
  assert.equal(reworkRate([pointEvent]), null)
  assert.equal(
    reworkRate([
      transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
      transition('d1', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'),
    ]),
    0,
  )
})

test('task-style transitions use the status field, not just stage', () => {
  const task = (entityRef: string, from: string, to: string, iso: string): BaselineEvent => ({
    source: 'hubspot',
    action: 'completed_task',
    entityType: 'task',
    entityRef,
    actorRef: 'owner_7',
    occurredAt: new Date(iso),
    previousState: { status: from },
    newState: { status: to },
  })
  assert.equal(hasTransitions([task('t1', 'open', 'COMPLETED', '2026-07-01T00:00:00Z')]), true)
  assert.equal(
    reworkRate([
      task('t1', 'open', 'COMPLETED', '2026-07-01T00:00:00Z'),
      task('t1', 'COMPLETED', 'open', '2026-07-02T00:00:00Z'),
      task('t1', 'open', 'COMPLETED', '2026-07-03T00:00:00Z'),
    ]),
    1,
  )
})
