import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGoal, settleStatus, type EvalGoal } from '../evaluate'

const DAY = 24 * 60 * 60 * 1000
const STALE = 2 * DAY
const t0 = new Date('2026-01-01T00:00:00Z')
const day = (n: number) => new Date(t0.getTime() + n * DAY)

const goal: EvalGoal = {
  direction: 'increase',
  startValue: 100,
  targetValue: 200,
  startAt: t0,
  targetDate: day(100),
}
const pt = (n: number, value: number) => ({ value, capturedAt: day(n) })

test('no datapoints → no_data', () => {
  const e = evaluateGoal(goal, [], day(10), STALE)
  assert.equal(e.riskLevel, 'no_data')
  assert.equal(e.currentValue, null)
  assert.equal(e.progress, null)
})

test('stale series → no_data', () => {
  const e = evaluateGoal(goal, [pt(1, 150)], day(10), STALE)
  assert.equal(e.riskLevel, 'no_data')
})

test('on pace → on_track', () => {
  // Day 50 of 100, value 150 = exactly 50% progress vs 50% expected.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 150)], day(50), STALE)
  assert.equal(e.riskLevel, 'on_track')
  assert.equal(e.currentValue, 150)
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('day-one goal with a baseline point → on_track (nothing expected yet)', () => {
  const e = evaluateGoal(goal, [pt(0, 100)], day(0), STALE)
  assert.equal(e.riskLevel, 'on_track')
})

test('graded shortfall → at_risk between 75% and 95% of pace', () => {
  // Day 50: expected 0.5. Progress 0.4 = 80% of pace.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 140)], day(50), STALE)
  assert.equal(e.riskLevel, 'at_risk')
})

test('below 75% of pace → off_track', () => {
  // Day 50: progress 0.2 = 40% of pace.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 120)], day(50), STALE)
  assert.equal(e.riskLevel, 'off_track')
})

test('projection clearing the target rescues a behind-pace goal', () => {
  // Behind pace at day 50 (progress 0.4) but accelerating: regression over
  // the last points projects past 200 by day 100.
  const points = [pt(40, 100), pt(45, 118), pt(49, 140)]
  const e = evaluateGoal(goal, points, day(50), STALE)
  assert.ok((e.projectedValue ?? 0) >= 200)
  assert.equal(e.riskLevel, 'on_track')
})

test('decreasing goal (savings): falling value is progress', () => {
  const savings: EvalGoal = { ...goal, direction: 'decrease', startValue: 1000, targetValue: 600 }
  // Day 50: value 800 = 50% of the 1000→600 span vs 50% expected.
  const e = evaluateGoal(savings, [pt(0, 1000), pt(49, 800)], day(50), STALE)
  assert.equal(e.riskLevel, 'on_track')
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('single datapoint → no projection, but progress computes', () => {
  const e = evaluateGoal(goal, [pt(49, 150)], day(50), STALE)
  assert.equal(e.projectedValue, null)
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('unsorted input is sorted internally', () => {
  const e = evaluateGoal(goal, [pt(49, 150), pt(0, 100)], day(50), STALE)
  assert.equal(e.currentValue, 150)
})

test('degenerate span (target === start) → no_data, no crash', () => {
  const degenerate: EvalGoal = { ...goal, targetValue: 100 }
  const e = evaluateGoal(degenerate, [pt(1, 100)], day(2), STALE)
  assert.equal(e.riskLevel, 'no_data')
})

test('settlement: past deadline, progress >= 1 → achieved', () => {
  const e = evaluateGoal(goal, [pt(99, 205)], day(101), STALE)
  assert.equal(settleStatus(goal, e, day(101)), 'achieved')
})

test('settlement: past deadline, short → missed', () => {
  const e = evaluateGoal(goal, [pt(99, 150)], day(101), STALE)
  assert.equal(settleStatus(goal, e, day(101)), 'missed')
})

test('no settlement before the deadline', () => {
  const e = evaluateGoal(goal, [pt(49, 150)], day(50), STALE)
  assert.equal(settleStatus(goal, e, day(50)), null)
})
