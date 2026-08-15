import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTrackedGoals, goalMovement, fmtUsdCompact, fmtRunTime, TRACKED_GOALS_LIMIT } from '../tracked'

const goal = (overrides: Record<string, unknown>) => ({
  id: 'g',
  status: 'active',
  startAt: '2026-08-01T00:00:00Z',
  direction: 'increase',
  unit: 'usd',
  startValue: 0,
  currentValue: null,
  ...overrides,
})

test('pickTrackedGoals: active only, newest startAt first, capped', () => {
  const goals = [
    goal({ id: 'old', startAt: '2026-01-01T00:00:00Z' }),
    goal({ id: 'paused', status: 'paused' }),
    goal({ id: 'a', startAt: '2026-08-10T00:00:00Z' }),
    goal({ id: 'b', startAt: '2026-08-09T00:00:00Z' }),
    goal({ id: 'c', startAt: '2026-08-08T00:00:00Z' }),
  ]
  const picked = pickTrackedGoals(goals as never[])
  assert.equal(picked.length, TRACKED_GOALS_LIMIT)
  assert.deepEqual(picked.map((g: { id: string }) => g.id), ['a', 'b', 'c'])
})

test('pickTrackedGoals tolerates undefined/null', () => {
  assert.deepEqual(pickTrackedGoals(undefined), [])
  assert.deepEqual(pickTrackedGoals(null), [])
})

test('goalMovement: null currentValue renders an em dash with no color', () => {
  assert.deepEqual(goalMovement(goal({}) as never), { text: '—', favorable: null })
})

test('goalMovement: percent goals render percentage POINTS, not fmt %', () => {
  const moved = goalMovement(goal({ unit: 'percent', startValue: 0.062, currentValue: 0.05, direction: 'decrease' }) as never)
  assert.equal(moved.text, '−1.2pp')
  assert.equal(moved.favorable, true) // decrease direction: falling is good
})

test('goalMovement: favorability follows direction, not sign', () => {
  const down = goalMovement(goal({ startValue: 100, currentValue: 80, direction: 'decrease', unit: 'count' }) as never)
  assert.equal(down.favorable, true)
  const up = goalMovement(goal({ startValue: 100, currentValue: 80, direction: 'increase', unit: 'count' }) as never)
  assert.equal(up.favorable, false)
})

test('goalMovement: usd delta uses compact money with explicit sign', () => {
  const moved = goalMovement(goal({ startValue: 0, currentValue: 142000 }) as never)
  assert.equal(moved.text, '+$142k')
})

test('fmtUsdCompact', () => {
  assert.equal(fmtUsdCompact(18.4), '$18.40')
  assert.equal(fmtUsdCompact(3100), '$3.1k')
  assert.equal(fmtUsdCompact(142000), '$142k')
  assert.equal(fmtUsdCompact(0), '$0')
})

test('fmtRunTime', () => {
  assert.equal(fmtRunTime(45), '45s')
  assert.equal(fmtRunTime(720), '12m')
  assert.equal(fmtRunTime(22320), '6.2h')
  assert.equal(fmtRunTime(0), '0s')
})
