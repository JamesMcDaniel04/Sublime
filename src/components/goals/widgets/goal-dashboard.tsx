'use client'

import type { ComponentType } from 'react'
import type { DashboardLayout, WidgetType } from '@/lib/goals/dashboard'
import type { GoalDetail, GoalMetricSeries } from '@/lib/types'
import type { Contribution } from '@/components/goals/contribution-panel'
import type { ImpactTiers } from '@/components/goals/impact-strip'
import { KpiWidget } from './kpi-widget'
import { TrendWidget } from './trend-widget'
import { ProgressWidget } from './progress-widget'
import { ComparisonWidget } from './comparison-widget'
import { RatioWidget } from './ratio-widget'
import { NarrativeWidget } from './narrative-widget'
import { ImpactWidget } from './impact-widget'
import { BenchmarkWidget } from './benchmark-widget'
import { PeriodsWidget } from './periods-widget'
import { ContributionsWidget } from './contributions-widget'
import { HistoryWidget } from './history-widget'
import { RollupsWidget } from './rollups-widget'

export type DashboardData = {
  goal: GoalDetail
  metrics: GoalMetricSeries[]
  contributions: Contribution[]
  impact: ImpactTiers
  preview?: boolean
  onReload: () => void | Promise<void>
}
export type WidgetProps = {
  config: Record<string, unknown>
  data: DashboardData
}

export function resolveMetric(
  data: DashboardData,
  metricId?: unknown,
): GoalMetricSeries | null {
  if (typeof metricId === 'string') {
    return data.metrics.find((metric) => metric.id === metricId) ?? null
  }
  return (
    data.metrics.find((metric) => metric.role === 'primary') ??
    data.metrics[0] ??
    null
  )
}

export const WIDGET_COMPONENTS: Record<
  WidgetType,
  ComponentType<WidgetProps>
> = {
  kpi: KpiWidget,
  trend: TrendWidget,
  progress: ProgressWidget,
  comparison: ComparisonWidget,
  ratio: RatioWidget,
  narrative: NarrativeWidget,
  impact: ImpactWidget,
  benchmark: BenchmarkWidget,
  periods: PeriodsWidget,
  contributions: ContributionsWidget,
  history: HistoryWidget,
  rollups: RollupsWidget,
}

export function GoalDashboard({
  layout,
  data,
}: {
  layout: DashboardLayout
  data: DashboardData
}) {
  return (
    <div className="space-y-6">
      {layout.widgets.map((widget) => {
        const Widget = WIDGET_COMPONENTS[widget.type]
        return (
          <Widget key={widget.id} config={widget.config} data={data} />
        )
      })}
    </div>
  )
}
