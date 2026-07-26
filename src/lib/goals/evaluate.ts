/**
 * Pure goal evaluation: progress vs linear pace, least-squares projection,
 * graded risk. Zero I/O, zero tokens — unit-tested exhaustively so the cron
 * tick and the API can both trust it.
 *
 * Risk grading: on_track at >= 95% of expected pace OR when the projection
 * clears the target; at_risk down to 75% of pace; off_track below. A stale or
 * empty series is 'no_data' — a metric nobody is reading must not look
 * healthy (same principle as connection verification).
 */
export type GoalRiskLevel = 'on_track' | 'at_risk' | 'off_track' | 'no_data'

export interface EvalGoal {
  direction: 'increase' | 'decrease'
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
}

export interface EvalPoint {
  value: number
  capturedAt: Date
}

export interface Evaluation {
  currentValue: number | null
  /** Fraction of the start→target span covered. Direction-agnostic: for
   *  decreasing goals the span is negative and the ratio stays positive. */
  progress: number | null
  /** Linear expected progress in [0, 1] for `now`. */
  expectedProgress: number
  /** Least-squares projection of the value at targetDate; null with < 2 points. */
  projectedValue: number | null
  riskLevel: GoalRiskLevel
}

const ON_TRACK_PACE_RATIO = 0.95
const AT_RISK_PACE_RATIO = 0.75

export function evaluateGoal(goal: EvalGoal, points: EvalPoint[], now: Date, staleAfterMs: number): Evaluation {
  const span = goal.targetValue - goal.startValue
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
  const latest = sorted.at(-1) ?? null

  const elapsed = now.getTime() - goal.startAt.getTime()
  const total = goal.targetDate.getTime() - goal.startAt.getTime()
  const expectedProgress = total <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / total))

  if (!latest || span === 0) {
    return { currentValue: latest?.value ?? null, progress: null, expectedProgress, projectedValue: null, riskLevel: 'no_data' }
  }
  if (now.getTime() - latest.capturedAt.getTime() > staleAfterMs) {
    const progress = (latest.value - goal.startValue) / span
    return { currentValue: latest.value, progress, expectedProgress, projectedValue: null, riskLevel: 'no_data' }
  }

  const progress = (latest.value - goal.startValue) / span
  const projectedValue = project(sorted, goal.targetDate)
  const projectedProgress = projectedValue === null ? null : (projectedValue - goal.startValue) / span

  let riskLevel: GoalRiskLevel
  if (progress >= 1) riskLevel = 'on_track'
  else if (expectedProgress === 0) riskLevel = 'on_track' // day one: nothing expected yet
  else if (progress >= ON_TRACK_PACE_RATIO * expectedProgress) riskLevel = 'on_track'
  else if (projectedProgress !== null && projectedProgress >= 1) riskLevel = 'on_track'
  else if (progress >= AT_RISK_PACE_RATIO * expectedProgress) riskLevel = 'at_risk'
  else riskLevel = 'off_track'

  return { currentValue: latest.value, progress, expectedProgress, projectedValue, riskLevel }
}

/** Ordinary least squares over (ms, value); evaluated at targetDate. */
function project(sorted: EvalPoint[], targetDate: Date): number | null {
  if (sorted.length < 2) return null
  const xs = sorted.map((p) => p.capturedAt.getTime())
  const ys = sorted.map((p) => p.value)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY)
    sxx += (xs[i] - meanX) ** 2
  }
  if (sxx === 0) return null // all points share one timestamp
  const slope = sxy / sxx
  return meanY + slope * (targetDate.getTime() - meanX)
}

/** Past-deadline settlement; null while the goal is still live. */
export function settleStatus(goal: EvalGoal, evaluation: Evaluation, now: Date): 'achieved' | 'missed' | null {
  if (now.getTime() <= goal.targetDate.getTime()) return null
  return (evaluation.progress ?? 0) >= 1 ? 'achieved' : 'missed'
}
