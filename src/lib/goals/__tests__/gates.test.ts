import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RISK_SEVERITY, applyCompositionGates } from '../composition/gates'
import type { GoalRiskLevel } from '../evaluate'

const clean = {
  completeness: {
    boundPct: 100,
    missing: [] as string[],
    stale: [] as string[],
    errored: [] as string[],
    level: 'complete' as const,
  },
  reconciliation: { status: 'reconciled' as const, variancePct: -1.2 },
  gateFindings: [],
}

const ALL_RISKS: GoalRiskLevel[] = ['on_track', 'at_risk', 'off_track', 'no_data']

test('a clean composition never changes the base risk', () => {
  for (const base of ALL_RISKS) {
    assert.equal(applyCompositionGates(base, clean).riskLevel, base)
  }
})

test('THE INVARIANT: no condition can ever improve a risk level', () => {
  const conditions = [
    clean,
    {
      ...clean,
      completeness: {
        ...clean.completeness,
        missing: ['churned_arr'],
        level: 'partial' as const,
      },
    },
    {
      ...clean,
      completeness: {
        ...clean.completeness,
        stale: ['new_arr'],
        level: 'partial' as const,
      },
    },
    {
      ...clean,
      completeness: {
        ...clean.completeness,
        errored: ['new_arr'],
        level: 'partial' as const,
      },
    },
    {
      ...clean,
      completeness: {
        ...clean.completeness,
        boundPct: 0,
        missing: ['a', 'b'],
        level: 'unbound' as const,
      },
    },
    { ...clean, reconciliation: { status: 'drifted' as const, variancePct: 22 } },
    {
      ...clean,
      reconciliation: { status: 'unmeasured' as const, variancePct: null },
    },
    {
      ...clean,
      gateFindings: [
        { slot: 'pipeline_coverage', value: 1.9, threshold: 3, breached: true },
      ],
    },
  ]
  for (const base of ALL_RISKS) {
    for (const condition of conditions) {
      const result = applyCompositionGates(base, condition)
      assert.ok(
        RISK_SEVERITY[result.riskLevel] >= RISK_SEVERITY[base],
        `${base} improved to ${result.riskLevel}`,
      )
    }
  }
})

test('a missing required component caps an on_track goal at at_risk', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: {
      ...clean.completeness,
      missing: ['churned_arr'],
      level: 'partial',
    },
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('churned_arr')))
})

test('a stale required component is no_data, not merely at_risk', () => {
  // An unread driver is unread — the same rule the headline already obeys.
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: { ...clean.completeness, stale: ['new_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'no_data')
})

test('an erroring required component is no_data', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: {
      ...clean.completeness,
      errored: ['new_arr'],
      level: 'partial',
    },
  })
  assert.equal(result.riskLevel, 'no_data')
})

test('drifted reconciliation caps at at_risk and records the variance', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    reconciliation: { status: 'drifted', variancePct: 22.4 },
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('22.4')))
})

test('a breached leading gate caps at at_risk and names the slot', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    gateFindings: [
      { slot: 'pipeline_coverage', value: 1.9, threshold: 3, breached: true },
    ],
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('pipeline_coverage')))
})

test('an unbreached gate contributes no reason', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    gateFindings: [
      { slot: 'pipeline_coverage', value: 4.2, threshold: 3, breached: false },
    ],
  })
  assert.equal(result.riskLevel, 'on_track')
  assert.deepEqual(result.reasons, [])
})

test('the worst condition wins when several apply', () => {
  const result = applyCompositionGates('on_track', {
    completeness: {
      boundPct: 75,
      missing: ['churned_arr'],
      stale: ['new_arr'],
      errored: [],
      level: 'partial',
    },
    reconciliation: { status: 'drifted', variancePct: 30 },
    gateFindings: [
      { slot: 'pipeline_coverage', value: 1, threshold: 3, breached: true },
    ],
  })
  assert.equal(result.riskLevel, 'no_data')
  // Every applicable reason is still reported, not just the winning one.
  assert.ok(result.reasons.length >= 4)
})

test('an already off_track goal is not softened by a no_data gate', () => {
  // no_data outranks off_track in this ordering, so it applies.
  const result = applyCompositionGates('off_track', {
    ...clean,
    completeness: { ...clean.completeness, stale: ['new_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'no_data')
})

test('unmeasured reconciliation alone does not downgrade', () => {
  // Nothing bound yet is a setup state, and completeness already reports it.
  // Downgrading twice for one fact would double-punish.
  const result = applyCompositionGates('on_track', {
    ...clean,
    reconciliation: { status: 'unmeasured', variancePct: null },
  })
  assert.equal(result.riskLevel, 'on_track')
})
