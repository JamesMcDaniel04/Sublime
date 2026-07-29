'use client'

import type { WorkStats } from '@/lib/goals/work-stats'

const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/**
 * Did the people given this work actually use it.
 *
 * The single question a process owner cannot answer today: every adoption
 * metric they have is self-reported — logged activity, ticked tasks, a box a
 * rep checks because a manager asked — and reps optimize those. Disposition is
 * not a report; it is the side effect of copying or skipping.
 *
 * Deliberately NOT a leaderboard. It leads with the team number, orders by
 * volume rather than rate, and names nobody as failing. A low number beside a
 * rep is usually a targeting problem, which is why their skip reasons sit in
 * the rules strip alongside it rather than in a separate performance view. A
 * table that reads as surveillance gets switched off at a 40-person revenue
 * team — and the disposition signal dies with it.
 */
export function WorkAdoptionStrip({ stats }: { stats: WorkStats }) {
  if (stats.overall.produced === 0) return null
  const { produced, used, worked, usedRate } = stats.overall

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-sm">
        <span className="font-medium">Team</span>
        {' — '}
        {produced} produced → <span className="font-medium">{used} used</span> ({pct(usedRate)}) →{' '}
        {worked} worked
      </p>
      {stats.byAssignee.length > 0 && (
        <ul className="space-y-0.5">
          {stats.byAssignee.map((row) => (
            <li
              key={row.assigneeUserId ?? 'unassigned'}
              className="flex justify-between gap-4 text-xs text-muted-foreground"
            >
              <span className="truncate">{row.assigneeName}</span>
              <span className="shrink-0 tabular-nums">
                {row.produced} → {row.used} ({pct(row.usedRate)})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
