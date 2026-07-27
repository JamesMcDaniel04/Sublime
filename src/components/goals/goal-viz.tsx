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

/** Validated chart data hue (see tailwind.config.js `chart`): horizon's
 *  chroma reads gray at chart weights, so data marks carry chart-blue. */
const DATA_BLUE = '#0284C7'
const DATA_VIOLET = '#7C3AED'

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
      className="relative h-2.5 w-full rounded-full bg-muted shadow-inner"
      role="img"
      aria-label={`Progress ${Math.round(pct)}%, pace ${Math.round(pacePct)}%`}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-chart-blue/80 to-chart-blue"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/70 ring-2 ring-background"
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
  const gradientId = useId().replace(/:/g, '')
  const paths = useMemo(() => {
    if (points.length < 2) return null
    const xs = points.map((point) => Date.parse(point.capturedAt))
    const ys = points.map((point) => point.value)
    const x = scaleLinear([Math.min(...xs), Math.max(...xs)], [2, width - 2])
    const y = scaleLinear([Math.min(...ys), Math.max(...ys)], [height - 3, 3])
    const coords = points.map((point) => ({
      x: x(Date.parse(point.capturedAt)),
      y: y(point.value),
    }))
    const line = linePath(coords)
    const first = coords[0]
    const last = coords.at(-1)!
    return {
      line,
      // Area closes to the bottom edge so the fill gives the line a body.
      area: `${line} L ${last.x} ${height - 1} L ${first.x} ${height - 1} Z`,
      last,
    }
  }, [points, width, height])
  if (!paths) return null
  return (
    <svg width={width} height={height} aria-hidden className="text-chart-blue">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={DATA_BLUE} stopOpacity={0.28} />
          <stop offset="100%" stopColor={DATA_BLUE} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={paths.area} fill={`url(#${gradientId})`} />
      <path
        d={paths.line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={paths.last.x}
        cy={paths.last.y}
        r={2.5}
        className="fill-chart-blue stroke-background"
        strokeWidth={1.5}
      />
    </svg>
  )
}

/**
 * Progress ring — the KPI widget's centerpiece. The arc is the progress made,
 * the notch on the track is where pace says you should be, so ahead/behind is
 * read as arc-past-notch at a glance.
 */
export function ProgressRing({
  progress,
  expectedProgress,
  size = 96,
}: {
  readonly progress: number | null
  readonly expectedProgress: number
  readonly size?: number
}) {
  const gradientId = useId().replace(/:/g, '')
  const stroke = 8
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const pct = progress === null ? 0 : Math.min(1, Math.max(0, progress))
  const pace = Math.min(1, Math.max(0, expectedProgress))
  const paceAngle = pace * 360 - 90
  const paceX = size / 2 + radius * Math.cos((paceAngle * Math.PI) / 180)
  const paceY = size / 2 + radius * Math.sin((paceAngle * Math.PI) / 180)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        role="img"
        aria-label={
          progress === null
            ? 'Progress not yet measured'
            : `Progress ${Math.round(pct * 100)}%, expected ${Math.round(pace * 100)}%`
        }
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={DATA_BLUE} />
            <stop offset="100%" stopColor={DATA_VIOLET} />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
        {/* Pace notch: where the arc should reach today. */}
        <circle
          cx={paceX}
          cy={paceY}
          r={3}
          className="fill-foreground/70 stroke-background"
          strokeWidth={1.5}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-xl font-bold leading-none">
          {progress === null ? '—' : `${Math.round((progress ?? 0) * 100)}%`}
        </span>
        <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          of target
        </span>
      </div>
    </div>
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
    const coords = sorted.map((point) => ({ x: x(Date.parse(point.capturedAt)), y: y(point.value) }))
    const actualPath = linePath(coords)
    // Close the actual line to the x-axis: the gradient body under the line
    // is what keeps the chart from reading as a wireframe.
    const areaPath = coords.length >= 2
      ? `${actualPath} L ${coords.at(-1)!.x} ${height - bottom} L ${coords[0].x} ${height - bottom} Z`
      : ''
    const lastCoord = coords.at(-1) ?? null
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
      areaPath,
      lastCoord,
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
          <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={DATA_BLUE} stopOpacity={0.22} />
            <stop offset="100%" stopColor={DATA_BLUE} stopOpacity={0} />
          </linearGradient>
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
                stroke={DATA_VIOLET}
                strokeOpacity={0.35}
                strokeDasharray="2 3"
              >
                <title>{marker.label}</title>
              </line>
              {/* AI-contribution marker: a violet diamond on the baseline. */}
              <rect
                x={chart.x(Date.parse(marker.at)) - 3}
                y={chart.height - chart.bottom - 3}
                width={6}
                height={6}
                fill={DATA_VIOLET}
                className="stroke-background"
                strokeWidth={1}
                transform={`rotate(45 ${chart.x(Date.parse(marker.at))} ${chart.height - chart.bottom})`}
              >
                <title>{marker.label}</title>
              </rect>
            </g>
          ))}
          {chart.areaPath && <path d={chart.areaPath} fill={`url(#${clipId}-fill)`} />}
          {chart.actualPath && (
            <path
              d={chart.actualPath}
              fill="none"
              className="stroke-chart-blue"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {chart.lastCoord && !hover && (
            <circle
              cx={chart.lastCoord.x}
              cy={chart.lastCoord.y}
              r={4}
              className="fill-chart-blue stroke-background"
              strokeWidth={2}
            />
          )}
          {chart.projection !== null && sorted.length >= 2 && (
            <line
              x1={chart.x(Date.parse(sorted.at(-1)!.capturedAt))}
              y1={chart.y(sorted.at(-1)!.value)}
              x2={chart.x(chart.targetMs)}
              y2={chart.y(chart.projection)}
              className="stroke-chart-blue/60"
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
                r={7}
                className="fill-chart-blue/20"
              />
              <circle
                cx={hoverX}
                cy={hoverY}
                r={4.5}
                className="fill-chart-blue stroke-background"
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
            // Collision avoidance: the Target/Pace labels occupy
            // [y(target)-7, y(target)+16]; a projection landing near the
            // target would overlap, so its label slides below that band.
            y={
              Math.abs(chart.y(chart.projection) - chart.y(goal.targetValue)) < 26
                ? chart.y(goal.targetValue) + 29
                : chart.y(chart.projection) + 3
            }
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
            // The rect spans only the plot area, so its client width maps to
            // the plot's SVG width — offsetting from chart.left, not 0.
            const bounds = event.currentTarget.getBoundingClientRect()
            const svgX =
              chart.left +
              ((event.clientX - bounds.left) / bounds.width) *
                (chart.width - chart.left - chart.right)
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
          {markers
            .filter((marker) => Math.abs(chart.x(Date.parse(marker.at)) - hoverX) < 14)
            .map((marker) => (
              <div key={`${marker.at}-${marker.label}`} className="mt-1 text-muted-foreground">
                ▲ {marker.label}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
