'use client'

import { Card } from '@/components/ui/card'
import { RiskBadge } from '@/components/goals/goal-viz'
import type { WidgetProps } from './goal-dashboard'

export function RollupsWidget({ data }: WidgetProps) {
  const { goal } = data
  if (goal.personal || goal.children.length === 0) return null
  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">Supporting personal goals</h2>
      {goal.children.map((child, index) => (
        <div
          key={child.id ?? `private-${index}`}
          className="flex items-center justify-between gap-3 rounded-xl border p-3"
        >
          <span className="text-sm font-medium">{child.name}</span>
          <RiskBadge riskLevel={child.riskLevel} />
        </div>
      ))}
    </Card>
  )
}
