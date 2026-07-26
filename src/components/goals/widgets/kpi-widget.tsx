'use client'

import { Card } from '@/components/ui/card'
import { fmtValue } from '@/components/goals/chart-math'
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
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">
            {metric?.label ?? 'Current'}
          </p>
          <p className="font-mono text-3xl font-bold">
            {latest === null || latest === undefined
              ? '—'
              : fmtValue(latest, metric?.unit ?? goal.unit)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Target</p>
          <p className="font-mono text-3xl font-bold">
            {fmtValue(goal.targetValue, goal.unit)}
          </p>
          <p className="text-xs text-muted-foreground">
            by {new Date(goal.targetDate).toLocaleDateString()}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Progress</p>
          <p className="font-mono text-3xl font-bold">
            {progress === null ? '—' : `${Math.round(progress * 100)}%`}
          </p>
          {paceDelta !== null && (
            <p
              className={`text-xs font-medium ${paceDelta >= 0 ? 'text-success' : 'text-warning'}`}
            >
              {paceDelta >= 0
                ? `${Math.round(paceDelta * 100)}% ahead of pace`
                : `${Math.round(-paceDelta * 100)}% behind pace`}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
