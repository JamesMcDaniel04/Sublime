import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMrrCents, type StripeSubscription } from '../sources/stripe'

const sub = (
  items: Array<{
    unit_amount: number
    interval: string
    interval_count?: number
    quantity?: number
  }>,
): StripeSubscription => ({
  items: {
    data: items.map((i) => ({
      quantity: i.quantity ?? 1,
      price: {
        unit_amount: i.unit_amount,
        recurring: { interval: i.interval, interval_count: i.interval_count ?? 1 },
      },
    })),
  },
})

test('monthly price counts at face value', () => {
  assert.equal(computeMrrCents([sub([{ unit_amount: 5000, interval: 'month' }])]), 5000)
})

test('annual price is normalized to monthly', () => {
  assert.equal(computeMrrCents([sub([{ unit_amount: 120000, interval: 'year' }])]), 10000)
})

test('quantity and interval_count multiply/divide', () => {
  assert.equal(
    computeMrrCents([
      sub([{ unit_amount: 5000, interval: 'month', interval_count: 3, quantity: 3 }]),
    ]),
    5000,
  )
})

test('weekly and daily intervals are normalized', () => {
  assert.equal(
    Math.round(computeMrrCents([sub([{ unit_amount: 1000, interval: 'week' }])])),
    Math.round(1000 * (365.25 / 84)),
  )
  assert.equal(
    Math.round(computeMrrCents([sub([{ unit_amount: 100, interval: 'day' }])])),
    Math.round(100 * (365.25 / 12)),
  )
})

test('null unit_amount (metered/tiered) is skipped, not NaN', () => {
  const metered = {
    items: {
      data: [
        {
          quantity: 1,
          price: { unit_amount: null, recurring: { interval: 'month', interval_count: 1 } },
        },
      ],
    },
  }
  assert.equal(computeMrrCents([metered as StripeSubscription]), 0)
})
