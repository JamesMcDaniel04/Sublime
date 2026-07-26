import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { GoalSummary } from '@/lib/types'
import { fmtValue } from './chart-math'
import { GoalProgressBar, RiskBadge, Sparkline } from './goal-viz'

export function GoalCard({ goal }: { readonly goal: GoalSummary }) {
  return (
    <Link href={`/goals/${goal.id}`} className="block h-full">
      <Card variant="interactive" className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{goal.name}</h3>
            {goal.personal && (
              <Badge variant="outline" className="mt-1 text-[10px]">
                Personal
              </Badge>
            )}
          </div>
          <RiskBadge riskLevel={goal.riskLevel} />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="font-mono text-2xl font-bold text-foreground">
              {goal.currentValue === null ? '—' : fmtValue(goal.currentValue, goal.unit)}
            </div>
            <p className="text-xs text-muted-foreground">
              of {fmtValue(goal.targetValue, goal.unit)} by{' '}
              {new Date(goal.targetDate).toLocaleDateString()}
            </p>
            {goal.recurrence && (
              <p className="mt-1 text-xs text-muted-foreground">
                ↻ {goal.recurrence}
              </p>
            )}
          </div>
          <Sparkline points={goal.sparkline} />
        </div>
        <GoalProgressBar
          progress={goal.progress}
          expectedProgress={goal.expectedProgress}
        />
        {goal.metric?.lastError && (
          <p className="flex items-start gap-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span className="line-clamp-2">
              Source failing — {goal.metric.lastError}
            </span>
          </p>
        )}
      </Card>
    </Link>
  )
}
