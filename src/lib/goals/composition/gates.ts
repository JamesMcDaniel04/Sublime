/**
 * Composition risk gates. These may only ever DOWNGRADE the risk that
 * evaluateGoal computed — composition can add doubt, never confidence. The
 * invariant is enforced by taking the max severity, and is tested across every
 * (baseRisk × condition) pair.
 *
 * Severity ordering puts no_data above off_track: a number nobody can read is
 * a worse position than a number that is readably behind, because it cannot be
 * acted on. This matches evaluateGoal, which already returns no_data for a
 * stale series rather than grading it.
 */
import type { GoalRiskLevel } from '../evaluate'
import type { CompletenessResult } from './completeness'
import type { GateFinding } from './rollup-quota'
import type { ReconcileStatus } from './reconcile'

export const RISK_SEVERITY: Record<GoalRiskLevel, number> = {
  on_track: 0,
  at_risk: 1,
  off_track: 2,
  no_data: 3,
}

const worst = (left: GoalRiskLevel, right: GoalRiskLevel): GoalRiskLevel =>
  RISK_SEVERITY[right] > RISK_SEVERITY[left] ? right : left

export function applyCompositionGates(
  baseRisk: GoalRiskLevel,
  input: {
    completeness: CompletenessResult
    reconciliation: { status: ReconcileStatus; variancePct: number | null }
    gateFindings: GateFinding[]
  },
): { riskLevel: GoalRiskLevel; reasons: string[] } {
  const reasons: string[] = []
  let riskLevel = baseRisk

  const { missing, stale, errored } = input.completeness
  if (missing.length > 0) {
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(`Composition incomplete — not bound: ${missing.join(', ')}.`)
  }
  if (stale.length > 0) {
    riskLevel = worst(riskLevel, 'no_data')
    reasons.push(`Driver not being read — stale: ${stale.join(', ')}.`)
  }
  if (errored.length > 0) {
    riskLevel = worst(riskLevel, 'no_data')
    reasons.push(`Driver source failing: ${errored.join(', ')}.`)
  }
  // 'unmeasured' is deliberately NOT a downgrade: completeness already reports
  // an unbound composition, and punishing the same fact twice would be double
  // counting.
  if (input.reconciliation.status === 'drifted') {
    const variance = (input.reconciliation.variancePct ?? 0).toFixed(1)
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(
      `Components do not reconcile to the reported number (${variance}% variance).`,
    )
  }
  for (const finding of input.gateFindings) {
    if (!finding.breached) continue
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(
      `${finding.slot} is ${finding.value} against a ${finding.threshold} floor.`,
    )
  }

  return { riskLevel, reasons }
}
