/**
 * Multi-goal arbitration: when one agent serves several goals, rank them so
 * the run has an explicit answer to "which goal wins when actions trade off"
 * instead of two grounding blocks and silence. Pure, zero I/O — same
 * discipline as evaluate.ts.
 *
 * Ranking: any user-set priority outranks every unset one (lower number =
 * more important); within a tier, live risk decides (off_track first), then
 * the nearest deadline, then id so equal goals rank deterministically.
 */
import type { GoalRiskLevel } from './evaluate'

export interface ArbitrationGoal {
  id: string
  name: string
  riskLevel: GoalRiskLevel
  targetDate: Date
  priority: number | null
}

const RISK_RANK: Record<GoalRiskLevel, number> = {
  off_track: 0,
  at_risk: 1,
  on_track: 2,
  no_data: 3,
}

export function rankGoals(goals: ArbitrationGoal[]): ArbitrationGoal[] {
  return [...goals].sort((a, b) => {
    if ((a.priority === null) !== (b.priority === null)) return a.priority === null ? 1 : -1
    if (a.priority !== null && b.priority !== null && a.priority !== b.priority) return a.priority - b.priority
    const risk = (RISK_RANK[a.riskLevel] ?? 4) - (RISK_RANK[b.riskLevel] ?? 4)
    if (risk !== 0) return risk
    const deadline = a.targetDate.getTime() - b.targetDate.getTime()
    if (deadline !== 0) return deadline
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** Prompt block for a multi-goal agent; empty below two goals — a single
 *  goal needs no arbitration and the extra block would be noise. */
export function arbitrationSection(ranked: ArbitrationGoal[]): string {
  if (ranked.length < 2) return ''
  const lines = ranked.map(
    (goal, index) =>
      `${index + 1}. ${goal.name} — ${goal.riskLevel}, due ${goal.targetDate.toISOString().slice(0, 10)}`,
  )
  return [
    '## Goal priorities',
    'This agent serves more than one goal. Current ranking, most important first:',
    ...lines,
    'When actions trade off between goals, favor the higher-ranked goal. Never spend a turn on a lower-ranked goal while a higher-ranked one has an available next step.',
  ].join('\n')
}
