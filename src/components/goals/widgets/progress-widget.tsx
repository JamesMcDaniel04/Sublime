'use client'

import { Card } from '@/components/ui/card'
import { GoalProgressBar } from '@/components/goals/goal-viz'
import type { WidgetProps } from './goal-dashboard'

export function ProgressWidget({ data }: WidgetProps) {
  if (data.goal.progress === null && !data.preview) return null
  return (
    <Card className="space-y-2 p-5">
      <div className="flex justify-between text-sm">
        <span className="font-medium">Progress</span>
        <span className="text-muted-foreground">
          {Math.round((data.goal.progress ?? 0) * 100)}%
        </span>
      </div>
      <GoalProgressBar
        progress={data.goal.progress}
        expectedProgress={data.goal.expectedProgress}
      />
    </Card>
  )
}
