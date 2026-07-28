import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TOLERANCE_PCT, reconcile } from '../composition/reconcile'

test('the default tolerance is 5 percent', () => {
  assert.equal(DEFAULT_TOLERANCE_PCT, 5)
})

test('neither number present is unmeasured', () => {
  const r = reconcile({ read: null, derived: null })
  assert.equal(r.status, 'unmeasured')
  assert.equal(r.variancePct, null)
})

test('only a read value is read_only', () => {
  const r = reconcile({ read: 100, derived: null })
  assert.equal(r.status, 'read_only')
  assert.equal(r.variancePct, null)
})

test('only a derived value is derived_only', () => {
  const r = reconcile({ read: null, derived: 100 })
  assert.equal(r.status, 'derived_only')
  assert.equal(r.variancePct, null)
})

test('a small gap reconciles and the variance is signed against the read value', () => {
  const r = reconcile({ read: 2_410_000, derived: 2_380_000 })
  assert.equal(r.status, 'reconciled')
  // Derived is below read, so variance is negative.
  assert.ok((r.variancePct ?? 0) < 0)
  assert.ok(Math.abs((r.variancePct ?? 0) + 1.2448) < 0.01)
})

test('derived above read gives a positive variance', () => {
  const r = reconcile({ read: 100, derived: 102 })
  assert.ok(Math.abs((r.variancePct ?? 0) - 2) < 1e-9)
  assert.equal(r.status, 'reconciled')
})

test('a gap beyond tolerance drifts', () => {
  const r = reconcile({ read: 100, derived: 120 })
  assert.equal(r.status, 'drifted')
  assert.ok(Math.abs((r.variancePct ?? 0) - 20) < 1e-9)
})

test('exactly at tolerance still reconciles', () => {
  const r = reconcile({ read: 100, derived: 105 })
  assert.equal(r.status, 'reconciled')
})

test('tolerance is overridable', () => {
  assert.equal(
    reconcile({ read: 100, derived: 120, tolerancePct: 25 }).status,
    'reconciled',
  )
  assert.equal(
    reconcile({ read: 100, derived: 103, tolerancePct: 1 }).status,
    'drifted',
  )
})

test('a zero read value cannot be a percentage base', () => {
  const r = reconcile({ read: 0, derived: 5 })
  assert.equal(r.variancePct, null)
  // Without a comparable base there is no drift claim to make.
  assert.equal(r.status, 'reconciled')
})

test('a negative read value uses its magnitude as the base', () => {
  // Decreasing goals can legitimately report negative values; the variance
  // sign must describe derived-vs-read, not the base's sign.
  const r = reconcile({ read: -100, derived: -110 })
  assert.ok(Math.abs((r.variancePct ?? 0) + 10) < 1e-9)
  assert.equal(r.status, 'drifted')
})
