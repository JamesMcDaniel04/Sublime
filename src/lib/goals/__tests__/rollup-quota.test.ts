import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COVERAGE_THRESHOLD, rollupQuota } from '../composition/rollup-quota'

const reps = () => [
  { currentValue: 120_000, targetValue: 200_000 },
  { currentValue: 180_000, targetValue: 200_000 },
  { currentValue: null, targetValue: 200_000 },
]

test('the default coverage threshold is 3x', () => {
  assert.equal(DEFAULT_COVERAGE_THRESHOLD, 3.0)
})

test('derived is the sum of child current values', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.equal(r.derived, 300_000)
})

test('a rep with no reading contributes nothing but still appears', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.equal(r.perRep.length, 3)
  assert.equal(r.perRep[2].currentValue, null)
  assert.equal(r.perRep[2].attainmentPct, null)
})

test('team attainment is derived over the summed targets', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.ok(Math.abs((r.attainmentPct ?? 0) - 300_000 / 600_000) < 1e-9)
})

test('no children yields derived null, not zero', () => {
  const r = rollupQuota([], new Map(), {})
  assert.equal(r.derived, null)
  assert.equal(r.attainmentPct, null)
  assert.deepEqual(r.perRep, [])
})

test('attainment is null when every target is zero', () => {
  const r = rollupQuota([{ currentValue: 10, targetValue: 0 }], new Map(), {})
  assert.equal(r.attainmentPct, null)
})

test('per-rep attainment is computed individually', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.ok(Math.abs((r.perRep[0].attainmentPct ?? 0) - 0.6) < 1e-9)
  assert.ok(Math.abs((r.perRep[1].attainmentPct ?? 0) - 0.9) < 1e-9)
})

test('coverage below the threshold is a breached gate', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 2.1]]), {})
  const finding = r.gateFindings.find((g) => g.slot === 'pipeline_coverage')
  assert.ok(finding)
  assert.equal(finding.breached, true)
  assert.equal(finding.threshold, 3.0)
})

test('coverage at or above the threshold is not breached', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 3.0]]), {})
  assert.equal(r.gateFindings[0].breached, false)
})

test('the coverage threshold is configurable', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 2.1]]), {
    coverageThreshold: 2.0,
  })
  assert.equal(r.gateFindings[0].breached, false)
  assert.equal(r.gateFindings[0].threshold, 2.0)
})

test('an unbound gate produces no finding at all', () => {
  // Absent is not the same as breached — an unmeasured gate must not accuse.
  const r = rollupQuota(reps(), new Map(), {})
  assert.deepEqual(r.gateFindings, [])
})
