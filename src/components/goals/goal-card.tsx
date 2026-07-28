import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { GoalSummary } from '@/lib/types'
import { fmtValue } from './chart-math'
import { GoalProgressBar, RiskBadge, Sparkline } from './goal-viz'
import { compositionBadge } from './composition-strip'

/** Risk → the card's top hairline gradient. Status is still named by the
 *  RiskBadge (icon + label); the hairline just lets a wall of cards scan. */
const RISK_BAR: Record<GoalSummary['riskLevel'], string> = {
  on_track: 'from-emerald-500 to-teal-400',
  at_risk: 'from-amber-500 to-orange-400',
  off_track: 'from-rose-500 to-red-400',
  no_data: 'from-border to-border',
}

export function GoalCard({ goal }: { readonly goal: GoalSummary }) {
  // Quiet when the composition is healthy or absent — a wall of cards should
  // only surface the ones that need attention.
  const badge = compositionBadge(goal.compositionState)
  return (
    <Link href={`/goals/${goal.id}`} className="block h-full">
      <Card
        variant="interactive"
        className="relative flex h-full flex-col gap-4 overflow-hidden p-5 pt-6"
      >
        <div
          aria-hidden
          className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${RISK_BAR[goal.riskLevel]}`}
        />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{goal.name}</h3>
            {goal.personal && (
              <Badge variant="outline" className="mt-1 text-[10px]">
                Personal
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <RiskBadge riskLevel={goal.riskLevel} />
            {badge && (
              <Badge
                variant="outline"
                className={
                  badge.tone === 'warn'
                    ? 'whitespace-nowrap border-warning/30 bg-warning/10 text-[10px] text-warning'
                    : 'whitespace-nowrap text-[10px] text-muted-foreground'
                }
              >
                {badge.label}
              </Badge>
            )}
          </div>
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
