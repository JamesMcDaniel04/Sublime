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

  return { overall: funnel(rows), byAgent }
}
