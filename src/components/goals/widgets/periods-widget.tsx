'use client'

import { fmtValue } from '@/components/goals/chart-math'
import { periodLabel } from '@/lib/goals/recurrence'
import type { GoalSummary } from '@/lib/types'
import type { WidgetProps } from './goal-dashboard'

export function PeriodsWidget({ data }: WidgetProps) {
  const { goal } = data
  if (!goal.recurrence || data.preview) return null
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label="Goal period history"
    >
      {[...goal.periods].reverse().map((period) => (
        <span
          key={period.periodEnd}
          title={`${fmtValue(period.finalValue, goal.unit)} final vs ${fmtValue(period.targetValue, goal.unit)} target`}
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            period.outcome === 'achieved'
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive'
          }`}
        >
          {periodLabel(
            new Date(period.periodEnd),
            goal.recurrence as Exclude<GoalSummary['recurrence'], null>,
          )}{' '}
          {period.outcome === 'achieved' ? '✓' : '✗'}
        </span>
      ))}
      <span className="rounded-full border border-chart-blue/30 bg-chart-blue/10 px-3 py-1 text-xs font-medium text-chart-blue">
        Current
      </span>
    </div>
  )
}
