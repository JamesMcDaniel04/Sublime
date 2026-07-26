'use client'

import { Card } from '@/components/ui/card'
import { Sparkline } from '@/components/goals/goal-viz'
import { ratioSeries, sampleSeries } from '@/lib/goals/series-math'
import { resolveMetric, type WidgetProps } from './goal-dashboard'

export function RatioWidget({ config, data }: WidgetProps) {
  const numerator = resolveMetric(data, config.numeratorId)
  const denominator = resolveMetric(data, config.denominatorId)
  if (!numerator || !denominator) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This series was removed.
      </Card>
    )
  }
  const points = data.preview
    ? sampleSeries(0.04, 0.12, data.goal.startAt, data.goal.targetDate)
    : ratioSeries(numerator.datapoints, denominator.datapoints)
  const latest = points.at(-1)
  const label = `${numerator.label ?? numerator.metricKey} ÷ ${denominator.label ?? denominator.metricKey}`
  const format = (value: number) =>
    config.format === 'ratio'
      ? value.toFixed(2)
      : `${(value * 100).toFixed(1)}%`
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Conversion</h2>
      <p className="text-xs text-muted-foreground">
        {label} · aligned by day, gaps skipped
      </p>
      {points.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Appears when both series have readings on the same day.
        </p>
      ) : (
        <div className="mt-3 flex items-end justify-between gap-4">
          <p className="font-mono text-3xl font-bold">
            {latest ? format(latest.value) : '—'}
          </p>
          <Sparkline points={points} />
        </div>
      )}
    </Card>
  )
}
