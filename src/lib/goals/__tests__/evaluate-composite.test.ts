import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGoal, type EvalGoal } from '../evaluate'
import {
  evaluateComposite,
  parseCompositionSpec,
  type ComponentReading,
} from '../composition/evaluate-composite'

const DAY = 24 * 60 * 60 * 1000
const STALE = 2 * DAY
const t0 = new Date('2026-01-01T00:00:00Z')
const day = (n: number) => new Date(t0.getTime() + n * DAY)

const goal: EvalGoal = {
  direction: 'increase',
  startValue: 2_000_000,
  targetValue: 3_000_000,
  startAt: t0,
  targetDate: day(100),
}
// Day 50 of 100 at 2.5M against a 2M→3M span is progress 0.5 vs expected 0.5,
// so the BASE evaluation is on_track. That matters: gates only downgrade, so a
// base that were already off_track would swallow every at_risk cap and make
// these assertions vacuous.
const headline = [
  { value: 2_000_000, capturedAt: day(0) },
  { value: 2_500_000, capturedAt: day(49) },
]

const arrSpec = { kind: 'arr' as const }
// Sums to exactly the read headline: 2M + (400k + 200k − 40k − 60k) = 2.5M.
const components = () => [
  { slot: 'new_arr', value: 400_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'expansion_arr', value: 200_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'contraction_arr', value: 40_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'churned_arr', value: 60_000, capturedAt: day(49), stale: false, errored: false },
]

test('NO REGRESSION: a null composition matches evaluateGoal exactly', () => {
  const base = evaluateGoal(goal, headline, day(50), STALE)
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: null,
    components: [],
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition, null)
  assert.deepEqual(
    {
      currentValue: composite.currentValue,
      progress: composite.progress,
      expectedProgress: composite.expectedProgress,
      projectedValue: composite.projectedValue,
      riskLevel: composite.riskLevel,
    },
    base,
  )
})

test('NO REGRESSION holds for an empty and a stale series too', () => {
  for (const points of [[], [{ value: 2_100_000, capturedAt: day(1) }]]) {
    const base = evaluateGoal(goal, points, day(50), STALE)
    const composite = evaluateComposite({
      goal,
      kind: 'arr',
      headlinePoints: points,
      composition: null,
      components: [],
      children: [],
      now: day(50),
      staleAfterMs: STALE,
    })
    assert.equal(composite.riskLevel, base.riskLevel)
    assert.equal(composite.currentValue, base.currentValue)
    assert.equal(composite.composition, null)
  }
})

test('a complete ARR composition reconciles and leaves risk alone', () => {
  const base = evaluateGoal(goal, headline, day(50), STALE)
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: components(),
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, base.riskLevel)
  assert.equal(composite.composition?.level, 'complete')
  assert.equal(composite.composition?.reconciliation, 'reconciled')
  assert.deepEqual(composite.composition?.reasons, [])
  // Components sum to exactly the read headline, and the base was on_track,
  // so a clean composition must leave it there.
  assert.equal(base.riskLevel, 'on_track')
  assert.equal(composite.composition?.derived, 2_500_000)
})

test('a missing ARR component downgrades and explains itself', () => {
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: components().slice(0, 3),
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, 'at_risk')
  assert.equal(composite.composition?.level, 'partial')
  assert.ok(composite.composition?.reasons.some((r) => r.includes('churned_arr')))
})

test('a stale component makes the goal no_data', () => {
  const stale = components()
  stale[0] = { ...stale[0], stale: true }
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: stale,
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, 'no_data')
})

test('components that do not reconcile to the headline drift', () => {
  const drifted = components()
  drifted[0] = { ...drifted[0], value: 1_200_000 }
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: drifted,
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition?.reconciliation, 'drifted')
  assert.equal(composite.riskLevel, 'at_risk')
})

test('a component with a null value counts as missing, not as zero', () => {
  const nulled: ComponentReading[] = components()
  nulled[0] = { ...nulled[0], value: null }
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: nulled,
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition?.derived, null)
  assert.ok(composite.composition?.missing.includes('new_arr'))
})

test('quota rolls up children and honours a custom coverage threshold', () => {
  const composite = evaluateComposite({
    goal: { ...goal, startValue: 0, targetValue: 600_000 },
    kind: 'quota',
    headlinePoints: [{ value: 300_000, capturedAt: day(49) }],
    composition: { kind: 'quota', coverageThreshold: 2.0 },
    components: [
      { slot: 'pipeline_coverage', value: 2.5, capturedAt: day(49), stale: false, errored: false },
    ],
    children: [
      { currentValue: 120_000, targetValue: 200_000 },
      { currentValue: 180_000, targetValue: 400_000 },
    ],
    now: day(50),
    staleAfterMs: STALE,
  })
  // 2.5 clears the lowered 2.0 floor, so no gate reason.
  assert.deepEqual(composite.composition?.breachedGates, [])
  assert.equal(composite.composition?.derived, 300_000)
})

test('quota below the default coverage floor breaches', () => {
  const composite = evaluateComposite({
    goal: { ...goal, startValue: 0, targetValue: 600_000 },
    kind: 'quota',
    headlinePoints: [{ value: 300_000, capturedAt: day(49) }],
    composition: { kind: 'quota' },
    components: [
      { slot: 'pipeline_coverage', value: 1.4, capturedAt: day(49), stale: false, errored: false },
    ],
    children: [{ currentValue: 300_000, targetValue: 600_000 }],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.deepEqual(composite.composition?.breachedGates, ['pipeline_coverage'])
  assert.equal(composite.riskLevel, 'at_risk')
})

test('a KPI ratio composition derives from its two slots', () => {
  const composite = evaluateComposite({
    goal: { ...goal, startValue: 0, targetValue: 1 },
    kind: 'kpi',
    headlinePoints: [{ value: 0.25, capturedAt: day(49) }],
    composition: { kind: 'kpi', shape: 'ratio' },
    components: [
      { slot: 'numerator', value: 42, capturedAt: day(49), stale: false, errored: false },
      { slot: 'denominator', value: 168, capturedAt: day(49), stale: false, errored: false },
    ],
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.ok(Math.abs((composite.composition?.derived ?? 0) - 0.25) < 1e-9)
  assert.equal(composite.composition?.reconciliation, 'reconciled')
})

test('parseCompositionSpec rejects junk rather than throwing', () => {
  assert.equal(parseCompositionSpec(null), null)
  assert.equal(parseCompositionSpec({}), null)
  assert.equal(parseCompositionSpec({ kind: 'nope' }), null)
  assert.equal(parseCompositionSpec({ kind: 'kpi' }), null) // shape required
  assert.deepEqual(parseCompositionSpec({ kind: 'arr' }), { kind: 'arr' })
})

test('parseCompositionSpec accepts each KPI shape', () => {
  assert.ok(parseCompositionSpec({ kind: 'kpi', shape: 'ratio' }))
  assert.ok(parseCompositionSpec({ kind: 'kpi', shape: 'funnel', stages: 3 }))
  assert.ok(
    parseCompositionSpec({
      kind: 'kpi',
      shape: 'weighted_sum',
      weights: { 'driver:a': 1 },
    }),
  )
})

test('a malformed persisted spec degrades the goal to uncomposed', () => {
  // Untrusted JSON must not throw inside a cron tick.
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: parseCompositionSpec({ kind: 'garbage' }),
    components: components(),
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition, null)
  assert.equal(composite.riskLevel, evaluateGoal(goal, headline, day(50), STALE).riskLevel)
})
