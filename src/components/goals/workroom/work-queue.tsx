'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import type { WorkPatch } from '@/lib/goals/work-transitions'
import type { WorkStats } from '@/lib/goals/work-stats'
import { WorkItem, type WorkItemData } from './work-item'
import { WorkFunnelStrip } from './work-funnel-strip'
import { WorkOutcomePrompt, needsOutcome } from './work-outcome-prompt'

const FILTERS = [
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Done' },
] as const

const EMPTY_STATS: WorkStats = {
  overall: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null },
  byAgent: [],
}

/**
 * The workroom.
 *
 * Sits above the dashboard on the goal page because the work is the point and
 * the number is the evidence, not the other way round.
 */
export function WorkQueue({ goalId }: { goalId: string }) {
  const [filter, setFilter] = useState<string>('mine')
  const [items, setItems] = useState<WorkItemData[]>([])
  const [stats, setStats] = useState<WorkStats>(EMPTY_STATS)
  // Learned from the same fetch that loads the queue — no /api/me round trip
  // and nothing for the goal page to thread down.
  const [viewerId, setViewerId] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/goals/${goalId}/work?filter=${filter}`, {
        cache: 'no-store',
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'could not load work')
      setItems(body.items ?? [])
      setStats(body.stats ?? EMPTY_STATS)
      setViewerId(body.viewerId ?? undefined)
    } catch {
      // Best-effort, like the rest of the goal page: an unreachable queue
      // renders as empty rather than breaking the goal.
      setItems([])
      setStats(EMPTY_STATS)
    } finally {
      setLoaded(true)
    }
  }, [goalId, filter])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback(
    async (id: string, body: WorkPatch) => {
      await fetch(`/api/goals/${goalId}/work/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await load()
    },
    [goalId, load],
  )

  // Computed from the loaded page rather than fetched separately: the prompt
  // is a nudge, not a report, so it only asks about what is already on screen.
  const awaitingOutcome = useMemo(() => {
    const now = Date.now()
    return items.filter((item) => needsOutcome(item, now))
  }, [items])

  return (
    <section className="space-y-3" aria-labelledby="goal-workroom-heading">
      <h2 id="goal-workroom-heading" className="text-sm font-semibold">
        Work
      </h2>

      <WorkFunnelStrip stats={stats} />

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter work">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            onClick={() => setFilter(entry.key)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              filter === entry.key
                ? 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200'
                : 'border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <WorkOutcomePrompt items={awaitingOutcome} onPatch={patch} />

      {loaded && items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No work yet"
          description="Agents write their work here as they produce it. Deploy an agent below to start."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <WorkItem
              key={item.id}
              item={item}
              currentUserId={viewerId}
              onPatch={(body) => void patch(item.id, body)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
