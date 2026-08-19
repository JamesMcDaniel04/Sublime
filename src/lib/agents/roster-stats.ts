/**
 * The two KPIs each roster tile shows, and the rules for choosing them.
 *
 * Deliberately does NOT read AgentTask.executionCount: that counter is
 * incremented both before a scheduled run (api/cron/dispatch, so a failing
 * agent stops re-firing) and again after a successful one (execute-agent), so
 * a scheduled agent that succeeds is counted twice. The agent_executions
 * ledger is the only trustworthy source, and a card whose job is to build
 * trust in an agent cannot be built on an inflated number.
 *
 * Pure so the route aggregates and the client renders against the same rules.
 */

/** One `groupBy(status)` bucket for a single agent. */
export type AgentRunTally = { status: string; count: number }

/** A goal↔agent link's minutes-saved estimate (GoalContribution). */
export type AgentContributionEstimate = {
  estimatedMinutesSavedPerRun: number
  estimateEdited: boolean
  createdAt: Date
}

export type AgentKpis = {
  /** Runs that delivered a result. */
  runs: number
  failed: number
  /** Every recorded run, whatever its status — drives "has this ever run?". */
  recorded: number
  /** Whole percent, or null when nothing has reached a terminal state. */
  successRate: number | null
  /** Null when the agent contributes to no goal. */
  minutesSavedPerRun: number | null
  hoursSaved: number | null
}

export type KpiSlot = {
  key: 'hoursSaved' | 'runs' | 'successRate'
  label: string
  display: string
  value: number | null
}

/**
 * Only these two statuses judge reliability.
 *
 * `cancelled` is terminal but human-caused — charging it to the agent makes the
 * number feel unjust. `waiting_for_input`, `running` and `pending` are still in
 * flight; counting a pending question as a defect would punish the agent for
 * asking. Any status added later is ignored rather than scored as a failure.
 */
const SUCCESS_STATUS = 'completed'
const FAILURE_STATUS = 'failed'

/**
 * Which goal's estimate to believe when an agent serves several. A human-edited
 * estimate is ground truth (GoalContribution.estimateEdited is set ONLY by a
 * person); provisioned defaults are guesses, so they lose even when larger.
 */
function primaryEstimate(contributions: AgentContributionEstimate[]): number | null {
  if (contributions.length === 0) return null
  const edited = contributions.filter((contribution) => contribution.estimateEdited)
  const pool = edited.length > 0 ? edited : contributions
  const newest = pool.reduce((best, candidate) => (candidate.createdAt > best.createdAt ? candidate : best), pool[0])
  return newest.estimatedMinutesSavedPerRun
}

export function computeAgentKpis(input: {
  tallies: AgentRunTally[]
  contributions: AgentContributionEstimate[]
}): AgentKpis {
  let runs = 0
  let failed = 0
  let recorded = 0
  for (const tally of input.tallies) {
    recorded += tally.count
    if (tally.status === SUCCESS_STATUS) runs += tally.count
    else if (tally.status === FAILURE_STATUS) failed += tally.count
  }
  const judged = runs + failed
  const minutesSavedPerRun = primaryEstimate(input.contributions)
  return {
    runs,
    failed,
    recorded,
    successRate: judged > 0 ? Math.round((runs / judged) * 100) : null,
    minutesSavedPerRun,
    hoursSaved: minutesSavedPerRun === null ? null : Math.round(((runs * minutesSavedPerRun) / 60) * 100) / 100,
  }
}

/**
 * Whether to show KPIs at all, or the "just hired" call to action.
 *
 * Any recorded run counts — including one that only ever failed. An agent that
 * has failed three times must never be indistinguishable from one nobody has
 * run yet; that is the whole point of putting reliability on the card.
 */
export function hasRunHistory(kpis: AgentKpis): boolean {
  return kpis.recorded > 0
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/**
 * The headline pair: time saved when a goal makes that meaningful, otherwise
 * delivered runs — then reliability. Tiles across a roster stay comparable on
 * the second slot even when the first differs.
 */
export function pickKpiSlots(kpis: AgentKpis): [KpiSlot, KpiSlot] {
  const lead: KpiSlot =
    kpis.hoursSaved === null
      ? { key: 'runs', label: 'runs', display: kpis.runs.toLocaleString('en-US'), value: kpis.runs }
      : { key: 'hoursSaved', label: 'saved', display: formatHours(kpis.hoursSaved), value: kpis.hoursSaved }
  return [
    lead,
    {
      key: 'successRate',
      label: 'success',
      display: kpis.successRate === null ? '—' : `${kpis.successRate}%`,
      value: kpis.successRate,
    },
  ]
}
