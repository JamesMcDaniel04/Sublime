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

test('period labels name the window that ENDED, not the one starting', () => {
  // periodEnd is exclusive: a window ending Jul 1 covers June / Q2.
  const end = new Date('2026-07-01T00:00:00Z')
  assert.equal(periodLabel(end, 'monthly'), 'Jun')
  assert.equal(periodLabel(end, 'quarterly'), 'Q2')
  assert.equal(periodLabel(end, 'yearly'), '2026')
  // A yearly window ending Jan 1 2027 is the 2026 year.
  assert.equal(periodLabel(new Date('2027-01-01T00:00:00Z'), 'yearly'), '2026')
})
