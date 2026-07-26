import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addPeriod, periodLabel } from '../recurrence'

test('monthly recurrence clamps the end of month', () => {
  assert.equal(
    addPeriod(new Date('2025-01-31T18:30:00Z'), 'monthly').toISOString(),
    '2025-02-28T18:30:00.000Z',
  )
  assert.equal(
    addPeriod(new Date('2024-01-31T18:30:00Z'), 'monthly').toISOString(),
    '2024-02-29T18:30:00.000Z',
  )
})

test('quarterly and yearly recurrence preserve calendar intent', () => {
  assert.equal(
    addPeriod(new Date('2025-11-30T23:59:59Z'), 'quarterly').toISOString(),
    '2026-02-28T23:59:59.000Z',
  )
  assert.equal(
    addPeriod(new Date('2024-02-29T12:00:00Z'), 'yearly').toISOString(),
    '2025-02-28T12:00:00.000Z',
  )
})

test('period labels use month, quarter, or year', () => {
  const end = new Date('2026-07-01T00:00:00Z')
  assert.equal(periodLabel(end, 'monthly'), 'Jul')
  assert.equal(periodLabel(end, 'quarterly'), 'Q3')
  assert.equal(periodLabel(end, 'yearly'), '2026')
})
