/**
 * Read-vs-derived reconciliation. When a headline can be read from a source
 * AND rolled up from components, the gap between them is the strongest proof
 * signal available: a composition that does not reconcile to the reported
 * number is either mis-bound or the source is wrong, and either is worth
 * saying out loud.
 *
 * A zero read value reconciles rather than drifts: with no comparable base
 * there is no percentage to compute, and accusing drift on missing information
 * would be the same error as treating an unread metric as healthy.
 */
export const DEFAULT_TOLERANCE_PCT = 5

export type ReconcileStatus =
  | 'reconciled'
  | 'drifted'
  | 'derived_only'
  | 'read_only'
  | 'unmeasured'

export function reconcile(input: {
  read: number | null
  derived: number | null
  tolerancePct?: number
}): { variancePct: number | null; status: ReconcileStatus } {
  const { read, derived } = input
  if (read === null && derived === null) {
    return { variancePct: null, status: 'unmeasured' }
  }
  if (derived === null) return { variancePct: null, status: 'read_only' }
  if (read === null) return { variancePct: null, status: 'derived_only' }
  if (read === 0) return { variancePct: null, status: 'reconciled' }

  // Magnitude as the base: decreasing goals legitimately report negative
  // values, and the variance sign must describe derived-vs-read rather than
  // inherit the base's sign.
  const variancePct = ((derived - read) / Math.abs(read)) * 100
  const tolerance = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT
  return {
    variancePct,
    status: Math.abs(variancePct) > tolerance ? 'drifted' : 'reconciled',
  }
}
