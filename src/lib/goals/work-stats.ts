/**
 * The produced → used → worked funnel over GoalWork rows. Pure, no I/O.
 *
 * This is DESCRIPTIVE, not causal. It reports what humans did with the work
 * and what they said happened next. It does not claim the work caused the goal
 * to move — that needs attribution and holdouts, which are a separate project.
 * Copy rendered from these numbers must say "used" and "worked", never
 * "caused".
 *
 * Note the two different denominators. `usedRate` is over everything produced,
 * so a high skip rate correctly reads as a targeting problem rather than
 * vanishing. `workedRate` is over what was actually used, because skipped work
 * was never sent and could not have landed.
 */
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'

export type WorkStatRow = {
  resourceId: string
  resourceName: string
  /** Null when nobody owns it — kept as its own bucket, never folded away. */
  assigneeUserId: string | null
  assigneeName: string
  disposition: Disposition
  outcome: Outcome
}

export type WorkFunnel = {
  produced: number
  used: number
  worked: number
  /** used / produced. Null only when nothing was produced. */
  usedRate: number | null
  /** worked / used. Null when nothing has been used yet. */
  workedRate: number | null
}

export type WorkStats = {
  overall: WorkFunnel
  byAgent: Array<{ resourceId: string; resourceName: string } & WorkFunnel>
  /** Adoption: did the people given this work actually use it. The one
   *  question a process owner cannot answer from a CRM, because running a play
   *  is not a CRM object. */
  byAssignee: Array<{ assigneeUserId: string | null; assigneeName: string } & WorkFunnel>
}

const USED: ReadonlySet<Disposition> = new Set<Disposition>(['used', 'edited'])

function funnel(rows: readonly WorkStatRow[]): WorkFunnel {
  const produced = rows.length
  const used = rows.filter((row) => USED.has(row.disposition)).length
  // The disposition check is deliberately repeated rather than assumed from
  // the outcome: the funnel stays honest even if a row reaches an impossible
  // state through some path other than the route.
  const worked = rows.filter(
    (row) => USED.has(row.disposition) && row.outcome === 'worked',
  ).length
  return {
    produced,
    used,
    worked,
    usedRate: produced > 0 ? used / produced : null,
    workedRate: used > 0 ? worked / used : null,
  }
}

export function computeWorkStats(rows: WorkStatRow[]): WorkStats {
  const byResource = new Map<string, WorkStatRow[]>()
  for (const row of rows) {
    const bucket = byResource.get(row.resourceId)
    if (bucket) bucket.push(row)
    else byResource.set(row.resourceId, [row])
  }

  const byAgent = [...byResource.entries()]
    .map(([resourceId, group]) => ({
      resourceId,
      resourceName: group[0].resourceName,
      ...funnel(group),
    }))
    .sort((a, b) => b.produced - a.produced || a.resourceName.localeCompare(b.resourceName))

  const byAssigneeMap = new Map<string, WorkStatRow[]>()
  for (const row of rows) {
    // The null bucket needs a stable key that cannot collide with a cuid.
    const key = row.assigneeUserId ?? ' unassigned'
    const bucket = byAssigneeMap.get(key)
    if (bucket) bucket.push(row)
    else byAssigneeMap.set(key, [row])
  }

  const byAssignee = [...byAssigneeMap.values()]
    .map((group) => ({
      assigneeUserId: group[0].assigneeUserId,
      assigneeName: group[0].assigneeName,
      ...funnel(group),
    }))
    // Volume, not rate — a workload view, never a leaderboard. Unassigned
    // always sorts last: work nobody owns is a routing finding, not a person.
    .sort((a, b) => {
      if (a.assigneeUserId === null) return 1
      if (b.assigneeUserId === null) return -1
      return b.produced - a.produced || a.assigneeName.localeCompare(b.assigneeName)
    })

  return { overall: funnel(rows), byAgent, byAssignee }
}
