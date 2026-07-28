import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositionBadge, compositionSummary } from '../composition-strip'

const base = {
  level: 'complete' as const,
  boundPct: 100,
  derived: 2_380_000,
  variancePct: -1.2,
  reconciliation: 'reconciled' as const,
  breachedGates: [] as string[],
  missing: [] as string[],
  reasons: [] as string[],
}

test('a null or undefined state renders nothing', () => {
  assert.equal(compositionSummary(null), null)
  assert.equal(compositionSummary(undefined), null)
})

test('a complete reconciled composition reads as ok with its variance', () => {
  const summary = compositionSummary(base)
  assert.equal(summary?.tone, 'ok')
  assert.ok(summary.headline.includes('reconcile'))
  assert.ok(summary.detail.some((line) => line.includes('1.2')))
  assert.ok(summary.detail.some((line) => line.includes('below')))
})

test('drift reads as a warning and names the size of the gap', () => {
  const summary = compositionSummary({
    ...base,
    derived: 900_000,
    variancePct: 42.5,
    reconciliation: 'drifted',
    reasons: ['Components do not reconcile to the reported number (42.5% variance).'],
  })
  assert.equal(summary?.tone, 'warn')
  assert.ok(summary.headline.includes('do not reconcile'))
  assert.ok(summary.detail.some((line) => line.includes('42.5')))
  assert.ok(summary.detail.some((line) => line.includes('above')))
})

test('missing drivers are named in human copy, not raw slot keys', () => {
  const summary = compositionSummary({
    ...base,
    level: 'partial',
    boundPct: 50,
    derived: null,
    variancePct: null,
    reconciliation: 'read_only',
    missing: ['churned_arr', 'contraction_arr'],
    reasons: ['Composition incomplete — not bound: churned_arr, contraction_arr.'],
  })
  assert.equal(summary?.tone, 'warn')
  const text = summary.detail.join(' ')
  assert.ok(text.includes('Churned ARR'), text)
  assert.ok(text.includes('Contraction ARR'), text)
})

test('an unbound composition is unknown, not a warning', () => {
  // Nothing bound yet is a setup state, not something wrong.
  const summary = compositionSummary({
    ...base,
    level: 'unbound',
    boundPct: 0,
    derived: null,
    variancePct: null,
    reconciliation: 'unmeasured',
    missing: ['new_arr'],
    reasons: [],
  })
  assert.equal(summary?.tone, 'unknown')
  assert.ok(summary.headline.includes('not bound'))
})

test('a breached gate is surfaced with its slot label', () => {
  const summary = compositionSummary({
    ...base,
    derived: 300_000,
    variancePct: 0,
    breachedGates: ['pipeline_coverage'],
    reasons: ['pipeline_coverage is 1.9 against a 3 floor.'],
  })
  assert.equal(summary?.tone, 'warn')
  const text = summary.detail.join(' ')
  assert.ok(text.includes('Pipeline coverage ratio'), text)
  assert.ok(text.includes('1.9'), text)
})

test('a stale driver reason is surfaced verbatim', () => {
  const summary = compositionSummary({
    ...base,
    level: 'partial',
    reasons: ['Driver not being read — stale: new_arr.'],
  })
  assert.equal(summary?.tone, 'warn')
  assert.ok(summary.detail.some((line) => line.includes('stale')))
})

test('a reconciled composition with no detail still has a headline', () => {
  const summary = compositionSummary({ ...base, variancePct: null })
  assert.equal(summary?.tone, 'ok')
  assert.ok(summary.headline.length > 0)
  assert.deepEqual(summary.detail, [])
})

test('the card badge is silent for a healthy or absent composition', () => {
  // A wall of cards should surface only what needs attention.
  assert.equal(compositionBadge(null), null)
  assert.equal(compositionBadge(undefined), null)
  assert.equal(compositionBadge(base), null, 'reconciled composition is quiet')
})

test('the card badge names the size of a drift', () => {
  const badge = compositionBadge({
    ...base,
    variancePct: -42.4,
    reconciliation: 'drifted',
  })
  assert.equal(badge?.tone, 'warn')
  assert.equal(badge.label, 'Drivers off by 42%')
})

test('the card badge reports unbound as neutral, not as a warning', () => {
  const badge = compositionBadge({
    ...base,
    level: 'unbound',
    boundPct: 0,
    derived: null,
    variancePct: null,
    reconciliation: 'unmeasured',
    missing: ['new_arr'],
  })
  assert.equal(badge?.tone, 'unknown')
  assert.equal(badge.label, 'Drivers not bound')
})

test('the card badge names a breached gate by its label', () => {
  const badge = compositionBadge({
    ...base,
    breachedGates: ['pipeline_coverage'],
    reasons: ['pipeline_coverage is 1.9 against a 3 floor.'],
  })
  assert.equal(badge?.tone, 'warn')
  assert.ok(badge.label.includes('Pipeline coverage'))
})

test('the card badge counts missing drivers when partially bound', () => {
  const badge = compositionBadge({
    ...base,
    level: 'partial',
    boundPct: 50,
    derived: null,
    variancePct: null,
    reconciliation: 'read_only',
    missing: ['churned_arr', 'contraction_arr'],
  })
  assert.equal(badge?.tone, 'warn')
  assert.ok(badge.label.includes('2'))
})
