'use client'

import { Card } from '@/components/ui/card'
import { GOAL_KIND_LABELS } from '@/lib/types'
import type { WidgetProps } from './goal-dashboard'

export function BenchmarkWidget({ data }: WidgetProps) {
  const { goal } = data
  if (!goal.benchmark) return null
  return (
    <Card className="border-muted bg-muted/30 p-5">
      <h2 className="font-semibold">How teams like yours do</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {goal.benchmark.achievedRate}% of {goal.benchmark.orgCount} orgs
        tracking {GOAL_KIND_LABELS[goal.kind]} targets hit their last period.
        {goal.benchmark.topSeeds[0]
          ? ` Most-adopted play: ${goal.benchmark.topSeeds[0].name}.`
          : ''}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Anonymous, cross-workspace counts · no goal values or workspace names
        shared
      </p>
    </Card>
  )
}
