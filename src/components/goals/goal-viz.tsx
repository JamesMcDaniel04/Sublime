'use client'

import { AlertTriangle, CircleCheck, CircleHelp, TrendingDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { GoalSummary } from '@/lib/types'
import { fmtValue, linePath, niceTicks, scaleLinear } from './chart-math'

const RISK: Record<
  GoalSummary['riskLevel'],
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  on_track: {
    label: 'On track',
    icon: CircleCheck,
    className: 'border-success/30 bg-success/10 text-success',
  },
  at_risk: {
    label: 'At risk',
    icon: AlertTriangle,
    className: 'border-warning/30 bg-warning/10 text-warning',
  },
  off_track: {
    label: 'Off track',
    icon: TrendingDown,
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
  no_data: {
    label: 'No data',
    icon: CircleHelp,
    className: 'border-border bg-muted text-muted-foreground',
  },
}

export function RiskBadge({
  riskLevel,
}: {
  readonly riskLevel: GoalSummary['riskLevel']
}) {
  const { label, icon: Icon, className } = RISK[riskLevel]
  return (
    <Badge variant="outline" className={cn('gap-1', className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </Badge>
  )
}

export function GoalProgressBar({
  progress,
  expectedProgress,
}: {
  readonly progress: number | null
  readonly expectedProgress: number
}) {
  const pct = Math.min(1, Math.max(0, progress ?? 0)) * 100
  const pacePct = Math.min(1, Math.max(0, expectedProgress)) * 100
  return (
    <div
      className="relative h-1.5 w-full rounded-full bg-muted"
      role="img"
      aria-label={`Progress ${Math.round(pct)}%, pace ${Math.round(pacePct)}%`}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-horizon-500"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-foreground/60"
        style={{ left: `${pacePct}%` }}
        title="Expected pace"
      />
    </div>
  )
}

export function Sparkline({
  points,
  width = 96,
  height = 28,
}: {
  readonly points: Array<{ value: number; capturedAt: string }>
  readonly width?: number
  readonly height?: number
}) {
  const d = useMemo(() => {
    if (points.length < 2) return ''
    const xs = points.map((point) => Date.parse(point.capturedAt))
    const ys = points.map((point) => point.value)
    const x = scaleLinear([Math.min(...xs), Math.max(...xs)], [2, width - 2])
    const y = scaleLinear([Math.min(...ys), Math.max(...ys)], [height - 2, 2])
    return linePath(
      points.map((point) => ({
        x: x(Date.parse(point.capturedAt)),
        y: y(point.value),
      })),
    )
  }, [points, width, height])
  if (!d) return null
  return (
    <svg width={width} height={height} aria-hidden className="text-horizon-500">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

type Point = { value: number; capturedAt: string }
type Marker = { at: string; label: string }

function projectedValue(points: Point[], targetMs: number): number | null {
  const usable = points.slice(-30)
  if (usable.length < 2) return null
  const xs = usable.map((point) => Date.parse(point.capturedAt))
  const ys = usable.map((point) => point.value)
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let sxy = 0
  let sxx = 0
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - meanX) * (ys[index] - meanY)
    sxx += (xs[index] - meanX) ** 2
  }
  return sxx === 0 ? null : meanY + (sxy / sxx) * (targetMs - meanX)
}

export function GoalTrendChart({
  goal,
  points,
  markers = [],
}: {
  readonly goal: GoalSummary
  readonly points: Point[]
  readonly markers?: Marker[]
}) {
  const clipId = useId().replace(/:/g, '')
  const [hovered, setHovered] = useState<number | null>(null)
  const sorted = useMemo(
    () => [...points].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)),
    [points],
  )
  const chart = useMemo(() => {
    const width = 640
    const height = 240
    const left = 58
    const right = 82
    const top = 18
    const bottom = 34
    const startMs = Date.parse(goal.startAt)
    const targetMs = Date.parse(goal.targetDate)
    const projection = projectedValue(sorted, targetMs)
    const values = [
      goal.startValue,
      goal.targetValue,
      ...sorted.map((point) => point.value),
      ...(projection === null ? [] : [projection]),
    ]
    const ticks = niceTicks(Math.min(...values), Math.max(...values), 5)
    const yMin = ticks[0] ?? Math.min(...values)
    const yMax = ticks.at(-1) ?? Math.max(...values)
    const x = scaleLinear([startMs, targetMs], [left, width - right])
    const y = scaleLinear([yMin, yMax], [height - bottom, top])
    const actualPath = linePath(
      sorted.map((point) => ({ x: x(Date.parse(point.capturedAt)), y: y(point.value) })),
    )
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      startMs,
      targetMs,
      projection,
      ticks,
      x,
      y,
      actualPath,
    }
  }, [goal, sorted])

  const hover = hovered === null ? null : sorted[hovered]
  const hoverX = hover ? chart.x(Date.parse(hover.capturedAt)) : 0
  const hoverY = hover ? chart.y(hover.value) : 0

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${goal.name} trend`}
        onMouseLeave={() => setHovered(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect
              x={chart.left}
              y={chart.top}
              width={chart.width - chart.left - chart.right}
              height={chart.height - chart.top - chart.bottom}
            />
          </clipPath>
        </defs>
        {chart.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={chart.left}
              x2={chart.width - chart.right}
              y1={chart.y(tick)}
              y2={chart.y(tick)}
              className="stroke-border/40"
            />
            <text
              x={chart.left - 8}
              y={chart.y(tick) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {fmtValue(tick, goal.unit)}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          <line
            x1={chart.x(chart.startMs)}
            y1={chart.y(goal.startValue)}
            x2={chart.x(chart.targetMs)}
            y2={chart.y(goal.targetValue)}
            className="stroke-muted-foreground"
            strokeDasharray="6 4"
          />
          <line
            x1={chart.left}
            x2={chart.width - chart.right}
            y1={chart.y(goal.targetValue)}
            y2={chart.y(goal.targetValue)}
            className="stroke-success/60"
          />
          {markers.map((marker) => (
            <g key={`${marker.at}-${marker.label}`}>
              <line
                x1={chart.x(Date.parse(marker.at))}
                x2={chart.x(Date.parse(marker.at))}
                y1={chart.top}
                y2={chart.height - chart.bottom}
                className="stroke-border"
              >
                <title>{marker.label}</title>
              </line>
              <text
                x={chart.x(Date.parse(marker.at))}
                y={chart.height - chart.bottom + 11}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                ▲
              </text>
            </g>
          ))}
          {chart.actualPath && (
            <path
              d={chart.actualPath}
              fill="none"
              className="stroke-horizon-500"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {chart.projection !== null && sorted.length >= 2 && (
            <line
              x1={chart.x(Date.parse(sorted.at(-1)!.capturedAt))}
              y1={chart.y(sorted.at(-1)!.value)}
              x2={chart.x(chart.targetMs)}
              y2={chart.y(chart.projection)}
              className="stroke-horizon-500/70"
              strokeWidth={2}
              strokeDasharray="2 4"
            />
          )}
          {hover && (
            <>
              <line
                x1={hoverX}
                x2={hoverX}
                y1={chart.top}
                y2={chart.height - chart.bottom}
                className="stroke-foreground/30"
              />
              <circle
                cx={hoverX}
                cy={hoverY}
                r={5}
                className="fill-horizon-500 stroke-background"
                strokeWidth={2}
              />
            </>
          )}
        </g>
        <text
          x={chart.width - chart.right + 6}
          y={chart.y(goal.targetValue) + 3}
          className="fill-success text-[10px]"
        >
          Target {fmtValue(goal.targetValue, goal.unit)}
        </text>
        <text
          x={chart.width - chart.right + 6}
          y={chart.y(goal.targetValue) + 16}
          className="fill-muted-foreground text-[10px]"
        >
          Pace
        </text>
        {chart.projection !== null && (
          <text
            x={chart.width - chart.right + 6}
            y={chart.y(chart.projection) + 3}
            className="fill-muted-foreground text-[10px]"
          >
            Projected
          </text>
        )}
        <rect
          x={chart.left}
          y={chart.top}
          width={chart.width - chart.left - chart.right}
          height={chart.height - chart.top - chart.bottom}
          fill="transparent"
          onMouseMove={(event) => {
            if (sorted.length === 0) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const svgX = ((event.clientX - bounds.left) / bounds.width) * chart.width
            let nearest = 0
            let distance = Number.POSITIVE_INFINITY
            sorted.forEach((point, index) => {
              const next = Math.abs(chart.x(Date.parse(point.capturedAt)) - svgX)
              if (next < distance) {
                nearest = index
                distance = next
              }
            })
            setHovered(nearest)
          }}
        />
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-popover"
          style={{
            left: `${(hoverX / chart.width) * 100}%`,
            top: `${(hoverY / chart.height) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 8px))',
          }}
        >
          <div className="font-medium">{fmtValue(hover.value, goal.unit)}</div>
          <div className="text-muted-foreground">
            {new Date(hover.capturedAt).toLocaleDateString()}
          </div>
        </div>
      )}
    </div>
  )
}
