import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunBudget, chargeRunBudget } from '../run-budget'

test('defaults to the 2M backstop when the env var is unset or garbage', () => {
  assert.equal(createRunBudget(undefined).cap, 2_000_000)
  assert.equal(createRunBudget('').cap, 2_000_000)
  assert.equal(createRunBudget('not-a-number').cap, 2_000_000)
  assert.equal(createRunBudget('500000').cap, 500_000)
})

test('explicit 0 keeps the unlimited opt-out; charge never trips it', () => {
  const budget = createRunBudget('0')
  assert.equal(budget.cap, 0)
  assert.equal(chargeRunBudget(budget, 10_000_000), false)
})

test('charging accumulates and trips at the cap', () => {
  const budget = createRunBudget('1000')
  assert.equal(chargeRunBudget(budget, 400), false)
  assert.equal(chargeRunBudget(budget, 599), false)
  assert.equal(chargeRunBudget(budget, 1), true)
  assert.equal(budget.spent, 1000)
})

test('a shared budget object is depleted across the whole sub-agent tree', () => {
  // Parent creates the budget; every child charges the SAME object, so
  // recursion can never multiply the per-run cap.
  const shared = createRunBudget('10000')
  const chargeAsChild = (tokens: number) => chargeRunBudget(shared, tokens)
  assert.equal(chargeAsChild(4000), false)
  assert.equal(chargeAsChild(4000), false)
  assert.equal(chargeAsChild(4000), true)
  assert.equal(shared.spent, 12_000)
})

test('prior spend (crash resume) seeds the budget', () => {
  const budget = createRunBudget('1000', 900)
  assert.equal(budget.spent, 900)
  assert.equal(chargeRunBudget(budget, 200), true)
})
