'use client'

/**
 * The goal lens control.
 *
 * Switching goals PRESERVES the current surface: changing lens from /flows
 * lands on that goal's flows, not on a dashboard. Losing your place is the
 * fastest way to make people stop using a switcher.
 */

import { usePathname } from 'next/navigation'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, Lock, Target } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { ALL_SCOPE, scopedHref, useScope } from '@/lib/client/scoped-href'
import type { GoalSummary } from '@/lib/types'

type GoalsResponse = { goals?: GoalSummary[] }
type BillingResponse = { capabilities?: { allGoalsView?: boolean } }

export function GoalSwitcher() {
  // Deliberately the RAW router: the href is already scoped by scopedHref
  // below, and useScopedRouter would scope it a second time.
  const router = useRouter()
  const pathname = usePathname()
  const scope = useScope()
  const { data: goalsData } = useCachedJson<GoalsResponse>('/api/goals')
  const { data: billing } = useCachedJson<BillingResponse>('/api/billing/status')

  const goals = goalsData?.goals ?? []
  const allGoalsView = billing?.capabilities?.allGoalsView ?? false
  // The <=1-goal exception, mirrored from resolveGoalScope: a workspace with
  // nothing to aggregate keeps the all-goals position, or it cannot reach the
  // page that creates its first goal.
  const allGoalsAllowed = allGoalsView || goals.length <= 1
  const current = scope === ALL_SCOPE ? null : goals.find((goal) => goal.id === scope)

  // Strip the existing /g/<scope> prefix to recover the bare surface, then
  // re-scope it. Falling back to /dashboard covers a pathname that somehow
  // carries no surface at all.
  const surface = pathname.replace(/^\/g\/[^/]+/, '') || '/dashboard'
  const go = (next: string) => router.push(scopedHref(next, surface))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Target className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate text-left">{current?.name ?? 'All goals'}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem
          onSelect={() => (allGoalsAllowed ? go(ALL_SCOPE) : router.push('/settings?tab=billing'))}
        >
          {allGoalsAllowed
            ? <Check className={scope === ALL_SCOPE ? 'mr-2 h-4 w-4' : 'mr-2 h-4 w-4 opacity-0'} />
            : <Lock className="mr-2 h-4 w-4 opacity-60" />}
          <span className="flex-1">All goals</span>
          {/* Shown LOCKED rather than hidden: an entitlement nobody can see is
              an entitlement nobody upgrades for. */}
          {!allGoalsAllowed && <span className="text-xs text-muted-foreground">Upgrade</span>}
        </DropdownMenuItem>
        {goals.map((goal) => (
          <DropdownMenuItem key={goal.id} onSelect={() => go(goal.id)}>
            <Check className={scope === goal.id ? 'mr-2 h-4 w-4' : 'mr-2 h-4 w-4 opacity-0'} />
            <span className="truncate">{goal.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
