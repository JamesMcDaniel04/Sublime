/**
 * Quota composition: team attainment is the sum of its child goals, because
 * `parentGoalId` + `ownerUserId` already model per-rep goals rolling into an
 * org goal. Component metrics on the quota goal itself carry only the leading
 * indicators that gate risk.
 *
 * An unbound gate produces no finding: absent is not breached, and an
 * unmeasured indicator must never accuse a goal — the same principle
 * evaluateGoal applies when it returns no_data instead of grading a stale
 * series.
 */
export const DEFAULT_COVERAGE_THRESHOLD = 3.0

export const QUOTA_GATE_SLOTS = [
  'pipeline_coverage',
  'win_rate',
  'avg_deal_size',
  'sales_cycle_days',
] as const

export type GateFinding = {
  slot: string
  value: number
  threshold: number
  breached: boolean
}

export type QuotaRollup = {
  derived: number | null
  attainmentPct: number | null
  perRep: Array<{
    currentValue: number | null
    targetValue: number
    attainmentPct: number | null
  }>
  gateFindings: GateFinding[]
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function rollupQuota(
  children: Array<{ currentValue: number | null; targetValue: number }>,
  gates: Map<string, number>,
  options: { coverageThreshold?: number },
): QuotaRollup {
  const threshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD

  const perRep = children.map((child) => ({
    currentValue: child.currentValue,
    targetValue: child.targetValue,
    attainmentPct:
      child.currentValue === null
        ? null
        : ratio(child.currentValue, child.targetValue),
  }))

  // Only pipeline coverage has an objective floor. The other leading
  // indicators are reported for context but have no universal threshold to
  // judge them against, so they never gate.
  const gateFindings: GateFinding[] = []
  const coverage = gates.get('pipeline_coverage')
  if (coverage !== undefined) {
    gateFindings.push({
      slot: 'pipeline_coverage',
      value: coverage,
      threshold,
      breached: coverage < threshold,
    })
  }

  if (children.length === 0) {
    return { derived: null, attainmentPct: null, perRep, gateFindings }
  }

  const derived = children.reduce(
    (sum, child) => sum + (child.currentValue ?? 0),
    0,
  )
  const targetTotal = children.reduce((sum, child) => sum + child.targetValue, 0)

  return {
    derived,
    attainmentPct: ratio(derived, targetTotal),
    perRep,
    gateFindings,
  }
}
