import type { AgentKpis } from './roster-stats'

/**
 * What the roster should tell you before you read the tiles.
 *
 * A team page that only lists members answers "who is here". It does not
 * answer the two questions someone opens it with: is anything wrong, and
 * should I be hiring. Both signals already existed in the data and were
 * visible only by reading every card in turn.
 */

export type TeamIssueKind = 'waiting' | 'failing' | 'never_run'

export interface TeamIssue {
  kind: TeamIssueKind
  agentId: string
  name: string
  /** What to say on the chip. */
  label: string
}

/**
 * Severity, lowest first.
 *
 * An agent blocked on a person is actionable right now. A failing one needs
 * looking at today. An agent that has never run has been that way for weeks —
 * real, but not urgent. Explicit rather than incidental, because this ordering
 * is what makes a truncated bar still surface the thing worth doing.
 */
export const ISSUE_RANK: Record<TeamIssueKind, number> = {
  waiting: 0,
  failing: 1,
  never_run: 2,
}

export interface TeamMember {
  id: string
  name: string
  kpis: AgentKpis
}

/**
 * The agents that need attention, most actionable first.
 *
 * One entry per agent, under its most severe issue: an agent that is both
 * blocked and failing is one problem to look at, and listing it twice would
 * make three problems look like six.
 *
 * Running is deliberately not an issue — flagging it would make the bar cry
 * wolf every time something worked.
 */
export function teamIssues(members: TeamMember[]): TeamIssue[] {
  const issues: TeamIssue[] = []

  for (const member of members) {
    const { waiting, failed, recorded } = member.kpis

    if (waiting > 0) {
      issues.push({
        kind: 'waiting',
        agentId: member.id,
        name: member.name,
        label: waiting === 1 ? 'Waiting on your answer' : `${waiting} runs waiting on you`,
      })
      continue
    }

    if (failed > 0) {
      issues.push({
        kind: 'failing',
        agentId: member.id,
        name: member.name,
        label: failed === 1 ? '1 run failed' : `${failed} runs failed`,
      })
      continue
    }

    // The quiet failure: it looks fine on the roster and has delivered nothing
    // since the day it was hired.
    if (recorded === 0) {
      issues.push({
        kind: 'never_run',
        agentId: member.id,
        name: member.name,
        label: 'Has never run',
      })
    }
  }

  // Stable within a rank, so the bar does not reshuffle between polls.
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => ISSUE_RANK[a.issue.kind] - ISSUE_RANK[b.issue.kind] || a.index - b.index)
    .map((entry) => entry.issue)
}
