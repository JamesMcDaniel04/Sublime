'use client'

import { Card } from '@/components/ui/card'
import {
  fmtValue,
  linePath,
  scaleLinear,
} from '@/components/goals/chart-math'
import { normalizeSeries, sampleSeries } from '@/lib/goals/series-math'
import { resolveMetric, type WidgetProps } from './goal-dashboard'

const COLORS = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981']
const W = 640
const H = 180
const PAD = 12

export function ComparisonWidget({ config, data }: WidgetProps) {
  const ids = Array.isArray(config.metricIds)
    ? (config.metricIds as string[])
    : []
  const series = ids
    .map((id) => resolveMetric(data, id))
    .filter((metric): metric is NonNullable<typeof metric> => metric !== null)
  if (series.length < 2) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This comparison needs two live series.
      </Card>
    )
  }
  const lines = series.map((metric) => {
    const points = data.preview
      ? sampleSeries(
          data.goal.startValue,
          data.goal.targetValue,
          data.goal.startAt,
          data.goal.targetDate,
        )
      : metric.datapoints
    return { metric, points, norm: normalizeSeries(points) }
  })
  const times = lines.flatMap((line) =>
    line.norm.map((point) => new Date(point.capturedAt).getTime()),
  )
  if (times.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="font-semibold">Series comparison</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Appears once these series have readings.
        </p>
      </Card>
    )
  }
  const x = scaleLinear(
    [Math.min(...times), Math.max(...times)],
    [PAD, W - PAD],
  )
  const y = scaleLinear([0, 1], [H - PAD, PAD])
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Series comparison</h2>
      <p className="text-xs text-muted-foreground">
        Each line on its own scale — shape, not magnitude.
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 w-full"
        role="img"
        aria-label="Comparison of tracked series"
      >
        {lines.map((line, index) => (
          <path
            key={line.metric.id}
            d={linePath(
              line.norm.map((point) => ({
                x: x(new Date(point.capturedAt).getTime()),
                y: y(point.t),
              })),
            )}
            fill="none"
            stroke={COLORS[index % COLORS.length]}
            strokeWidth={2}
          />
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4">
        {lines.map((line, index) => (
          <span
            key={line.metric.id}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: COLORS[index % COLORS.length] }}
            />
            {line.metric.label ?? line.metric.metricKey}
            {line.points.length > 0 && (
              <span className="font-mono font-medium text-foreground">
                {fmtValue(
                  line.points.at(-1)!.value,
                  line.metric.unit,
                )}
              </span>
            )}
          </span>
        ))}
      </div>
    </Card>
  )
}
