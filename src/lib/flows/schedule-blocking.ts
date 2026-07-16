/**
 * Overlap-guard decision for scheduled flows. The cron dispatcher skips a
 * flow's tick while its latest run is still active so a slow flow never stacks
 * concurrent scheduled executions. Pure companion to the reaper in ./reap:
 * `running` runs are reaped after 30 min, so they always block here; `waiting`
 * runs are a legitimate pause (ask-user) the reaper must not touch
 * — but an unanswered one must not wedge the schedule forever, so after 24h it
 * stops blocking while the run itself stays answerable.
 */

export const STALE_WAITING_BLOCK_MS = 24 * 60 * 60 * 1000

/** Does the flow's latest run still block starting the next scheduled run? */
export function blocksSchedule(run: { status: string; startedAt: Date }, now: Date = new Date()): boolean {
  if (run.status === 'running') return true
  if (run.status !== 'waiting') return false
  return now.getTime() - run.startedAt.getTime() < STALE_WAITING_BLOCK_MS
}
