'use client'

import { Card } from '@/components/ui/card'
import type { WidgetProps } from './goal-dashboard'

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`
}

function ImpactFigure({
  tier,
  value,
  label,
}: {
  tier: string
  value: string
  label: string
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{tier}</p>
      <p className="font-mono text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export function ImpactWidget({ data }: WidgetProps) {
  if (data.preview) {
    return (
      <Card className="border-dashed p-5 text-sm text-muted-foreground">
        Measured impact appears once automations link to this goal.
      </Card>
    )
  }
  const { impact } = data
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Impact on this goal</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ImpactFigure
          tier="Measured"
          value={String(impact.measured.runsCompleted)}
          label="completed actions"
        />
        <ImpactFigure
          tier="Estimated"
          value={`${impact.estimated.hoursSaved.toFixed(1)}h`}
          label="manual time saved"
        />
        <ImpactFigure
          tier="Estimated"
          value={`$${Math.round(impact.estimated.laborValueUsd).toLocaleString()}`}
          label="labor value created"
        />
        <ImpactFigure
          tier="Estimated"
          value={
            impact.estimated.roiMultiple === null
              ? '—'
              : `${impact.estimated.roiMultiple.toFixed(1)}×`
          }
          label="ROI on AI cost"
        />
      </div>
      {impact.measured.runsCompleted > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          {formatDuration(
            impact.measured.aiRunSecondsTotal /
              impact.measured.runsCompleted,
          )}{' '}
          measured AI time vs ~
          {Math.round(
            (impact.estimated.hoursSaved * 60) /
              impact.measured.runsCompleted,
          )}{' '}
          min manual estimate per run.
        </p>
      )}
      {impact.correlated.paceDeltaPct !== null && (
        <p
          className={`mt-4 text-sm font-medium ${
            impact.correlated.paceDeltaPct >= 0
              ? 'text-success'
              : 'text-warning'
          }`}
        >
          {impact.correlated.paceDeltaPct >= 0
            ? `Closing the gap ${impact.correlated.paceDeltaPct.toFixed(0)}% faster since AI started helping.`
            : `Pace is ${Math.abs(impact.correlated.paceDeltaPct).toFixed(0)}% slower since automations were linked — worth a look.`}
          <span className="ml-2 text-xs font-normal uppercase tracking-wide text-muted-foreground">
            correlation
          </span>
        </p>
      )}
    </Card>
  )
}
