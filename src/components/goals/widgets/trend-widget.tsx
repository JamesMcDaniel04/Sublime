'use client'

import { Card } from '@/components/ui/card'
import { GoalTrendChart } from '@/components/goals/goal-viz'
import { sampleSeries } from '@/lib/goals/series-math'
import type { GoalSummary } from '@/lib/types'
import { resolveMetric, type WidgetProps } from './goal-dashboard'

export function TrendWidget({ config, data }: WidgetProps) {
  const metric = resolveMetric(data, config.metricId)
  if (typeof config.metricId === 'string' && !metric) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This series was removed.
      </Card>
    )
  }
  if (!metric) return null
  const points = data.preview
    ? sampleSeries(
        data.goal.startValue,
        data.goal.targetValue,
        data.goal.startAt,
        data.goal.targetDate,
      )
    : metric.datapoints
  if (points.length === 0 && !data.preview) return null

  const values = points.map((point) => point.value)
  const min = values.length ? Math.min(...values) : data.goal.startValue
  const max = values.length ? Math.max(...values) : data.goal.targetValue
  const chartGoal: GoalSummary = {
    ...data.goal,
    name: metric.label ?? data.goal.name,
    unit: metric.unit,
    startValue: metric.role === 'primary' ? data.goal.startValue : min,
    targetValue:
      metric.role === 'primary'
        ? data.goal.targetValue
        : max === min
          ? min + Math.abs(min || 1) * 0.1
          : max,
    sparkline: points,
  }
  return (
    <Card className="p-5">
      <div className="mb-3">
        <h2 className="font-semibold">
          {metric.label ? `${metric.label} trend` : 'Trend and pace'}
        </h2>
        <p className="text-xs text-muted-foreground">
          Solid is actual, dashed is target pace, dotted is projection.
        </p>
      </div>
      <GoalTrendChart
        goal={chartGoal}
        points={points}
        markers={
          metric.role === 'primary' && !data.preview
            ? data.contributions.map((contribution) => ({
                at: contribution.createdAt,
                label: `AI showed up here · ${contribution.name}`,
              }))
            : []
        }
      />
    </Card>
  )
}
