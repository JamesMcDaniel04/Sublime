'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Target } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'
import type { GoalSummary } from '@/lib/types'
import { GoalProgressBar, RiskBadge } from './goal-viz'

export function GoalStatusStrip() {
  const [goals, setGoals] = useState<GoalSummary[] | null>(null)

  useEffect(() => {
    let cancelled = false
    getCachedJson<{ goals?: GoalSummary[] }>('/api/goals', 60_000)
      .then((data) => {
        if (!cancelled) {
          setGoals(
            (data.goals ?? [])
              .filter((goal) => !goal.personal && goal.status === 'active')
              .slice(0, 3),
          )
        }
      })
      .catch(() => {
        if (!cancelled) setGoals([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!goals?.length) return null

  return (
    <div className="mb-4 rounded-2xl border bg-card p-3 shadow-1">
      <div className="mb-2 flex items-center gap-2 px-1">
        <Target className="h-4 w-4 text-horizon-500" aria-hidden />
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Organization goals
        </p>
      </div>
      <div className="grid gap-1 sm:grid-cols-3">
        {goals.map((goal) => (
          <Link
            key={goal.id}
            href={`/goals/${goal.id}`}
            className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-muted"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{goal.name}</span>
            <span className="w-[60px] shrink-0">
              <GoalProgressBar
                progress={goal.progress}
                expectedProgress={goal.expectedProgress}
              />
            </span>
            <RiskBadge riskLevel={goal.riskLevel} />
          </Link>
        ))}
      </div>
    </div>
  )
}
