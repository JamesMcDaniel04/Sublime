'use client'

import type { WorkStats } from '@/lib/goals/work-stats'

const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/**
 * produced → used → worked, overall and per agent.
 *
 * The per-agent rows are the point: they answer "which of my agents is
 * actually worth running" from recorded fact rather than an estimate.
 *
 * Copy is deliberately descriptive — "used" and "worked", never "caused".
 * These are counts of what people did and reported, not an attribution claim;
 * that needs holdouts and is a separate project.
 */
export function WorkFunnelStrip({ stats }: { stats: WorkStats }) {
  if (stats.overall.produced === 0) return null
  const { produced, used, worked, usedRate, workedRate } = stats.overall

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-sm">
        <span className="font-medium">{produced} produced</span>
        {' → '}
        <span className="font-medium">{used} used</span> ({pct(usedRate)})
        {' → '}
        <span className="font-medium">{worked} worked</span> ({pct(workedRate)})
      </p>
      {stats.byAgent.length > 0 && (
        <ul className="space-y-0.5">
          {stats.byAgent.map((agent) => (
            <li
              key={agent.resourceId}
              className="flex justify-between gap-4 text-xs text-muted-foreground"
            >
              <span className="truncate">{agent.resourceName}</span>
              <span className="shrink-0 tabular-nums">
                {agent.produced} → {agent.used} → {agent.worked}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
