/**
 * Selection + formatting for the Home "Goals in flight" strip. Pure (no
 * React, no fetch) so it is directly unit-testable — the lib/flows/recent.ts
 * pattern this strip replaces.
 */
import type { GoalSummary } from '@/lib/types'

export type TrackedGoalInput = Pick<
  GoalSummary,
  'id' | 'status' | 'startAt' | 'direction' | 'unit' | 'startValue' | 'currentValue'
>

/** Rows shown on the Home strip. */
export const TRACKED_GOALS_LIMIT = 3

/** Most recently created active goals. */
export function pickTrackedGoals<T extends TrackedGoalInput>(goals: T[] | null | undefined): T[] {
  if (!Array.isArray(goals)) return []
  return goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
    .slice(0, TRACKED_GOALS_LIMIT)
}

/** `$18.40` under $1k (cents matter at that scale), `$3.1k` / `$142k` above. */
export function fmtUsdCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs === 0) return '$0'
  if (abs < 1000) return `$${abs.toFixed(2)}`
  const thousands = abs / 1000
  return `$${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`
}

/** Measured run time: `45s`, `12m`, `6.2h`. */
export function fmtRunTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

/**
 * The MOVED cell: currentValue − startValue on the goal's primary metric.
 *
 * - Percent goals render the delta in percentage POINTS (`−1.2pp`) — the
 *   level formatter's ×100-and-% is correct for levels, wrong-reading for
 *   deltas.
 * - `favorable` is direction AGREEMENT, not sign: a negative delta on a
 *   decrease goal (churn, savings) is favorable. Sign-only coloring would
 *   paint every successful cost-reduction goal red.
 * - No data yet (null currentValue) → em dash, no color.
 *
 * Uses the typographic minus (−) so the sign column aligns with the `pp`
 * rendering in the UI.
 */
export function goalMovement(
  goal: Pick<GoalSummary, 'direction' | 'unit' | 'startValue' | 'currentValue'>,
): { text: string; favorable: boolean | null } {
  if (goal.currentValue === null || goal.currentValue === undefined) {
    return { text: '—', favorable: null }
  }
  const delta = goal.currentValue - goal.startValue
  if (delta === 0) return { text: '±0', favorable: null }
  const favorable = goal.direction === 'decrease' ? delta < 0 : delta > 0
  const sign = delta > 0 ? '+' : '−'
  const abs = Math.abs(delta)
  const magnitude =
    goal.unit === 'percent'
      ? `${(abs * 100).toFixed(1)}pp`
      : goal.unit === 'usd'
        ? fmtUsdCompact(abs) // unsigned; the sign prefix is added below
        : abs >= 1000
          ? `${(abs / 1000).toFixed(1)}k`
          : String(Math.round(abs))
  return { text: `${sign}${magnitude}`, favorable }
}
