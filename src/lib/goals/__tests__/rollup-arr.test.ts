import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARR_REQUIRED_SLOTS, rollupArr } from '../composition/rollup-arr'

const full = () =>
  new Map([
    ['new_arr', 310_000],
    ['expansion_arr', 95_000],
    ['contraction_arr', 41_000],
    ['churned_arr', 130_000],
  ])

test('required slots are the four ARR movements', () => {
  assert.deepEqual([...ARR_REQUIRED_SLOTS].sort(), [
    'churned_arr',
    'contraction_arr',
    'expansion_arr',
    'new_arr',
  ])
})

test('signed sum: start + new + expansion − contraction − churn', () => {
  const r = rollupArr(2_000_000, full())
  assert.equal(r.netNew, 310_000 + 95_000 - 41_000 - 130_000)
  assert.equal(r.derived, 2_000_000 + 234_000)
  assert.deepEqual(r.missing, [])
})

test('contraction and churn are subtracted even when supplied negative', () => {
  // Some sources report churn as a negative number; magnitude is what matters,
  // and a sign flip must not silently turn a loss into a gain.
  const m = full()
  m.set('contraction_arr', -41_000)
  m.set('churned_arr', -130_000)
  const r = rollupArr(2_000_000, m)
  assert.equal(r.derived, 2_234_000)
})

test('a missing required slot yields derived null and names the gap', () => {
  const m = full()
  m.delete('churned_arr')
  const r = rollupArr(2_000_000, m)
  assert.equal(r.derived, null)
  assert.equal(r.netNew, null)
  assert.deepEqual(r.missing, ['churned_arr'])
  assert.deepEqual(r.present.sort(), [
    'contraction_arr',
    'expansion_arr',
    'new_arr',
  ])
})

test('all slots missing yields derived null, not zero', () => {
  const r = rollupArr(2_000_000, new Map())
  assert.equal(r.derived, null)
  assert.equal(r.present.length, 0)
  assert.equal(r.missing.length, 4)
})

test('NRR and GRR compute from the movements against startValue', () => {
  const r = rollupArr(1_000_000, full())
  // NRR = (start + expansion − contraction − churn) / start
  assert.ok(
    Math.abs(
      (r.nrr ?? 0) - (1_000_000 + 95_000 - 41_000 - 130_000) / 1_000_000,
    ) < 1e-9,
  )
  // GRR excludes expansion.
  assert.ok(
    Math.abs((r.grr ?? 0) - (1_000_000 - 41_000 - 130_000) / 1_000_000) < 1e-9,
  )
})

test('NRR and GRR are null when startValue is zero, not Infinity', () => {
  const r = rollupArr(0, full())
  assert.equal(r.nrr, null)
  assert.equal(r.grr, null)
})

test('logo churn needs both customer slots', () => {
  const partial = full()
  partial.set('customers_start', 400)
  assert.equal(rollupArr(1_000_000, partial).logoChurn, null)
  partial.set('customers_churned', 12)
  assert.ok(Math.abs((rollupArr(1_000_000, partial).logoChurn ?? 0) - 0.03) < 1e-9)
})

test('logo churn is null when the starting customer count is zero', () => {
  const m = full()
  m.set('customers_start', 0)
  m.set('customers_churned', 0)
  assert.equal(rollupArr(1_000_000, m).logoChurn, null)
})

test('optional customer slots never appear in missing', () => {
  const r = rollupArr(1_000_000, full())
  assert.ok(!r.missing.includes('customers_start'))
  assert.ok(!r.missing.includes('customers_churned'))
})
