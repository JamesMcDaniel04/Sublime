'use client'

import { Activity, Flag } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { fmtValue } from '@/components/goals/chart-math'
import { ProgressRing } from '@/components/goals/goal-viz'
import { resolveMetric, type WidgetProps } from './goal-dashboard'

export function KpiWidget({ config, data }: WidgetProps) {
  const { goal } = data
  const metric = resolveMetric(data, config.metricId)
  if (typeof config.metricId === 'string' && !metric) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This series was removed.
      </Card>
    )
  }
  const latest = metric?.datapoints.at(-1)?.value ?? goal.currentValue
  const progress = goal.progress
  const paceDelta =
    progress === null ? null : progress - goal.expectedProgress
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4 sm:flex-nowrap">
        <ProgressRing
          progress={progress}
          expectedProgress={goal.expectedProgress}
        />
        <div className="grid min-w-0 flex-1 gap-6 sm:grid-cols-2">
          <div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-chart-blue/10 text-chart-blue">
                <Activity className="h-3 w-3" aria-hidden />
              </span>
              <span>{metric?.label ?? 'Current'}</span>
            </p>
            <p className="mt-1.5 font-mono text-3xl font-bold">
              {latest === null || latest === undefined
                ? '—'
                : fmtValue(latest, metric?.unit ?? goal.unit)}
            </p>
            {paceDelta !== null && (
              <p
                className={`mt-1 text-xs font-medium ${paceDelta >= 0 ? 'text-success' : 'text-warning'}`}
              >
                {paceDelta >= 0
                  ? `${Math.round(paceDelta * 100)}% ahead of pace`
                  : `${Math.round(-paceDelta * 100)}% behind pace`}
              </p>
            )}
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-chart-emerald/10 text-chart-emerald">
                <Flag className="h-3 w-3" aria-hidden />
              </span>
              <span>Target</span>
            </p>
            <p className="mt-1.5 font-mono text-3xl font-bold">
              {fmtValue(goal.targetValue, goal.unit)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              by {new Date(goal.targetDate).toLocaleDateString()}
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
