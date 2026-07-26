'use client'

import { ContributionPanel } from '@/components/goals/contribution-panel'
import type { WidgetProps } from './goal-dashboard'

export function ContributionsWidget({ data }: WidgetProps) {
  if (data.preview) return null
  return (
    <ContributionPanel
      goalId={data.goal.id}
      contributions={data.contributions}
      onChanged={async () => {
        await data.onReload()
      }}
    />
  )
}
