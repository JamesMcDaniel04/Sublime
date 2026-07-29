'use client'

import type { WorkStats } from '@/lib/goals/work-stats'

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
  // The team total lives in the adoption strip, which always renders beside
  // this one. Repeating it here just puts the same sentence on screen twice.
  if (stats.byAgent.length === 0) return null

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">By agent</p>
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
