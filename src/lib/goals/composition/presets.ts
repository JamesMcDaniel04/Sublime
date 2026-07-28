/**
 * Per-kind composition validation, and the entitlement seam.
 *
 * assertKindAllowed is deliberately a discrete predicate rather than a zod
 * refine: the platform-editions work (spec 2026-07-28 §8) gates creatable kinds
 * at exactly this point, and it must compose with kind validation rather than
 * duplicate it.
 */
import type { GoalKind } from '../kind-migration'
import { ARR_OPTIONAL_SLOTS, ARR_REQUIRED_SLOTS } from './rollup-arr'
import { QUOTA_GATE_SLOTS } from './rollup-quota'
import { kpiRequiredSlots, type KpiShape } from './rollup-kpi'
import { parseCompositionSpec } from './evaluate-composite'

export function assertKindAllowed(
  kind: GoalKind,
  allowedKinds: readonly GoalKind[],
): string | null {
  if (allowedKinds.includes(kind)) return null
  return `This workspace cannot create ${kind} goals. Available: ${allowedKinds.join(', ')}.`
}

const OPTIONAL_SLOTS: Record<GoalKind, readonly string[]> = {
  arr: ARR_OPTIONAL_SLOTS,
  quota: QUOTA_GATE_SLOTS,
  kpi: [],
}

export function validateComposition(
  kind: GoalKind,
  composition: unknown,
  slots: string[],
): string | null {
  // Composition is opt-in: no declaration means an ordinary single-number goal.
  if (composition === null || composition === undefined) return null

  const spec = parseCompositionSpec(composition)
  if (!spec) return 'That composition is not a shape this goal kind understands.'
  if (spec.kind !== kind) {
    return `The composition kind (${spec.kind}) must match the goal kind (${kind}).`
  }

  const required =
    spec.kind === 'arr'
      ? [...ARR_REQUIRED_SLOTS]
      : spec.kind === 'quota'
        ? []
        : kpiRequiredSlots(spec.shape as KpiShape, {
            stages: spec.stages,
            weights: spec.weights,
          })

  const missing = required.filter((slot) => !slots.includes(slot))
  if (missing.length > 0) {
    return `Bind a source for: ${missing.join(', ')}.`
  }

  // A slot outside the vocabulary would never be read by any rollup, so it
  // would sit inert and invisible. Reject it as the typo it almost certainly is.
  const known = new Set([...required, ...OPTIONAL_SLOTS[kind]])
  const unknown = slots.filter((slot) => !known.has(slot))
  if (unknown.length > 0) {
    return `Not a ${kind} component: ${unknown.join(', ')}.`
  }

  const duplicates = slots.filter((slot, index) => slots.indexOf(slot) !== index)
  if (duplicates.length > 0) {
    return `One source per component: ${[...new Set(duplicates)].join(', ')} appears twice.`
  }

  return null
}
