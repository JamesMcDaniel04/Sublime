import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderGoalGrounding } from '../grounding'

const now = new Date('2026-07-15T00:00:00Z')
const base = {
  direction: 'increase',
  unit: 'usd',
  startValue: 0,
  targetValue: 100,
  startAt: new Date('2026-07-01T00:00:00Z'),
  targetDate: new Date('2026-07-31T00:00:00Z'),
  currentValue: 20,
}

test('goal grounding ranks by risk then deadline and takes three', () => {
  const block = renderGoalGrounding(
    [
      { ...base, name: 'On track', riskLevel: 'on_track' },
      { ...base, name: 'Risk', riskLevel: 'at_risk' },
      { ...base, name: 'No data', riskLevel: 'no_data' },
      { ...base, name: 'Worst', riskLevel: 'off_track' },
    ],
    now,
  )
  assert.ok(block.indexOf('Worst') < block.indexOf('Risk'))
  assert.ok(block.indexOf('Risk') < block.indexOf('No data'))
  assert.doesNotMatch(block, /On track/)
  assert.match(block, /behind pace/)
})

test('goal grounding is empty without goals and hard-capped', () => {
  assert.equal(renderGoalGrounding([], now), '')
  const long = renderGoalGrounding(
    Array.from({ length: 3 }, (_, index) => ({
      ...base,
      name: `${index}-${'x'.repeat(500)}`,
      riskLevel: 'off_track',
    })),
    now,
  )
  assert.ok(long.length <= 600)
})
