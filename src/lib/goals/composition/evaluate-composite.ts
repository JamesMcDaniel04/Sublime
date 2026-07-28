/**
 * Composite evaluation wrapper (spec 2026-07-28).
 *
 * evaluateGoal is called unchanged for the base evaluation and remains the only
 * thing that computes progress, pace, projection and base risk. This wrapper
 * then rolls up components, reconciles them against the read headline, measures
 * completeness, and applies gates that can only downgrade.
 *
 * A null composition returns the base evaluation verbatim — that property is
 * locked by test, because every goal in the database predates composition.
 */
import { z } from 'zod'
import { evaluateGoal, type EvalGoal, type EvalPoint, type Evaluation } from '../evaluate'
import type { GoalKind } from '../kind-migration'
import { ARR_REQUIRED_SLOTS, rollupArr } from './rollup-arr'
import { rollupQuota, type GateFinding } from './rollup-quota'
import { kpiRequiredSlots, rollupKpi, type KpiShape } from './rollup-kpi'
import { reconcile, type ReconcileStatus } from './reconcile'
import { compositionCompleteness, type CompletenessLevel } from './completeness'
import { applyCompositionGates } from './gates'

const compositionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('arr'),
    tolerancePct: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('quota'),
    tolerancePct: z.number().positive().optional(),
    coverageThreshold: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('kpi'),
    shape: z.enum(['funnel', 'ratio', 'weighted_sum']),
    stages: z.number().int().min(2).max(10).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    tolerancePct: z.number().positive().optional(),
  }),
])

export type CompositionSpec = z.infer<typeof compositionSchema>

/** Persisted JSON is untrusted: a malformed spec degrades the goal to
 *  uncomposed rather than throwing inside a cron tick. */
export function parseCompositionSpec(value: unknown): CompositionSpec | null {
  const parsed = compositionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type ComponentReading = {
  slot: string
  value: number | null
  capturedAt: Date | null
  stale: boolean
  errored: boolean
}

export type CompositionState = {
  level: CompletenessLevel
  boundPct: number
  derived: number | null
  variancePct: number | null
  reconciliation: ReconcileStatus
  breachedGates: string[]
  missing: string[]
  reasons: string[]
}

export function compositionRequiredSlots(spec: CompositionSpec): string[] {
  if (spec.kind === 'arr') return [...ARR_REQUIRED_SLOTS]
  // Quota's rollup reads child goals, not component metrics, so no component
  // slot is required — the leading indicators are all optional.
  if (spec.kind === 'quota') return []
  return kpiRequiredSlots(spec.shape as KpiShape, {
    stages: spec.stages,
    weights: spec.weights,
  })
}

export function evaluateComposite(input: {
  goal: EvalGoal
  kind: GoalKind
  headlinePoints: EvalPoint[]
  composition: CompositionSpec | null
  components: ComponentReading[]
  children: Array<{ currentValue: number | null; targetValue: number }>
  now: Date
  staleAfterMs: number
}): Evaluation & { composition: CompositionState | null } {
  const base = evaluateGoal(
    input.goal,
    input.headlinePoints,
    input.now,
    input.staleAfterMs,
  )
  const spec = input.composition
  if (!spec) return { ...base, composition: null }

  // A component with no reading is MISSING, not zero — only real values enter
  // the rollup, so an unread driver cannot masquerade as a measured nothing.
  const values = new Map<string, number>()
  for (const component of input.components) {
    if (component.value !== null) values.set(component.slot, component.value)
  }

  let derived: number | null = null
  let gateFindings: GateFinding[] = []
  if (spec.kind === 'arr') {
    derived = rollupArr(input.goal.startValue, values).derived
  } else if (spec.kind === 'quota') {
    const rollup = rollupQuota(input.children, values, {
      coverageThreshold: spec.coverageThreshold,
    })
    derived = rollup.derived
    gateFindings = rollup.gateFindings
  } else {
    derived = rollupKpi(spec.shape as KpiShape, values, {
      stages: spec.stages,
      weights: spec.weights,
    }).derived
  }

  const completeness = compositionCompleteness({
    required: compositionRequiredSlots(spec),
    present: [...values.keys()],
    stale: input.components.filter((c) => c.stale).map((c) => c.slot),
    errored: input.components.filter((c) => c.errored).map((c) => c.slot),
  })
  const reconciliation = reconcile({
    read: base.currentValue,
    derived,
    tolerancePct: spec.tolerancePct,
  })
  const gated = applyCompositionGates(base.riskLevel, {
    completeness,
    reconciliation,
    gateFindings,
  })

  return {
    ...base,
    riskLevel: gated.riskLevel,
    composition: {
      level: completeness.level,
      boundPct: completeness.boundPct,
      derived,
      variancePct: reconciliation.variancePct,
      reconciliation: reconciliation.status,
      breachedGates: gateFindings.filter((g) => g.breached).map((g) => g.slot),
      missing: completeness.missing,
      reasons: gated.reasons,
    },
  }
}
