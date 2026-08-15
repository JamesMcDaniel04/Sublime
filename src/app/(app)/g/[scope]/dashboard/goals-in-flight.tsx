'use client'

import { useMemo } from 'react'
import { ScopedLink } from '@/components/ui/scoped-link'
import { ALL_SCOPE, useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'
import { pickTrackedGoals, goalMovement, fmtUsdCompact, fmtRunTime } from '@/lib/goals/tracked'
import type { ImpactTiers } from '@/lib/goals/impact'
import type { GoalSummary } from '@/lib/types'

const RISK_DOT: Record<GoalSummary['riskLevel'], string> = {
  on_track: 'bg-emerald-500',
  at_risk: 'bg-amber-500',
  off_track: 'bg-rose-500',
  no_data: 'border bg-transparent',
}

type BatchResponse = { success?: boolean; impact?: Record<string, ImpactTiers> }

/**
 * "Goals in flight" — the 3 most recently created active goals with the four
 * numbers: MOVED (measured metric movement), SPENT (AI cost), TIME (measured
 * run seconds), VALUE (estimated labor value, marked ~). Replaces the
 * RecentFlows strip. Renders nothing while loading, on error, with zero
 * active goals, or under a single-goal lens — that goal has a whole surface;
 * a "top 3" beside "View all" would read as a bug there. The impact fetch
 * failing degrades to — cells; the strip itself stays.
 */
export function GoalsInFlight({ goals }: { goals: GoalSummary[] | null }) {
  const scope = useScope()
  const tracked = useMemo(() => pickTrackedGoals(goals), [goals])
  // Sorted ids → stable cache key regardless of goal ordering changes.
  const ids = useMemo(() => tracked.map((goal) => goal.id).sort().join(','), [tracked])
  const { data } = useCachedJson<BatchResponse>(
    scope === ALL_SCOPE && ids ? `/api/goals/impact/batch?ids=${encodeURIComponent(ids)}` : null,
  )
  if (scope !== ALL_SCOPE || tracked.length === 0) return null
  const impact = data?.impact ?? {}
  const cell = (goalId: string, pick: (tiers: ImpactTiers) => string) => {
    const tiers = impact[goalId]
    return tiers ? pick(tiers) : '—'
  }
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-muted-foreground">Goals in flight</p>
        <ScopedLink
          href="/goals"
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View all →
        </ScopedLink>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border bg-card shadow-1">
        {/* Column header — hidden on mobile where rows stack their own labels */}
        <div className="hidden grid-cols-[1fr_repeat(4,5.5rem)] gap-2 border-b px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
          <span>Goal</span>
          <span className="text-right">Moved</span>
          <span className="text-right">Spent</span>
          <span className="text-right">Time</span>
          <span className="text-right" title="Estimated labor value">
            Value
          </span>
        </div>
        {tracked.map((goal) => {
          const moved = goalMovement(goal)
          return (
            <ScopedLink
              key={goal.id}
              href={`/goals/${goal.id}`}
              className="grid grid-cols-1 gap-1 border-b px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent sm:grid-cols-[1fr_repeat(4,5.5rem)] sm:gap-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={cn('h-2 w-2 shrink-0 rounded-full', RISK_DOT[goal.riskLevel])}
                />
                <span className="truncate font-medium">{goal.name}</span>
              </span>
              <Metric label="Moved" value={moved.text} tone={moved.favorable} />
              <Metric label="Spent" value={cell(goal.id, (t) => fmtUsdCompact(t.estimated.aiCostUsd))} />
              <Metric label="Time" value={cell(goal.id, (t) => fmtRunTime(t.measured.aiRunSecondsTotal))} />
              <Metric label="Value" value={cell(goal.id, (t) => `~${fmtUsdCompact(t.estimated.laborValueUsd)}`)} />
            </ScopedLink>
          )
        })}
      </div>
    </div>
  )
}

/** One number cell: right-aligned on desktop, label/value pair on mobile. */
function Metric({ label, value, tone }: { label: string; value: string; tone?: boolean | null }) {
  return (
    <span className="flex items-baseline justify-between tabular-nums sm:justify-end">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground sm:hidden">{label}</span>
      <span
        className={cn(
          tone === true && 'text-emerald-600',
          tone === false && 'text-rose-600',
          tone == null && 'text-foreground',
        )}
      >
        {value}
      </span>
    </span>
  )
}
