'use client'

import { Button } from '@/components/ui/button'
import type { WorkPatch } from '@/lib/goals/work-transitions'
import type { WorkItemData } from './work-item'

/** Only work this old is worth asking about. Anything fresher has not had time
 *  to land, and asking would train people to answer noise. */
export const OUTCOME_PROMPT_AGE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Used or edited, old enough to have landed, and nobody has said yet.
 *
 * Skipped items are excluded by construction: nothing was ever sent, so
 * "did it land?" has no coherent answer — and the route would refuse the
 * write anyway.
 */
export function needsOutcome(item: WorkItemData, now: number): boolean {
  if (item.disposition !== 'used' && item.disposition !== 'edited') return false
  if (item.outcome !== 'unknown') return false
  return now - new Date(item.createdAt).getTime() >= OUTCOME_PROMPT_AGE_DAYS * DAY_MS
}

/**
 * The entire mechanism for populating `outcome` without polling a CRM: two
 * taps, no navigation, on work old enough to have an answer.
 */
export function WorkOutcomePrompt({
  items,
  onPatch,
}: {
  items: WorkItemData[]
  onPatch: (id: string, patch: WorkPatch) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="space-y-2 rounded-xl border border-dashed bg-muted/40 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">
        Did these land? {items.length} sent over a week ago
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{item.subject}</span>
            <span className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPatch(item.id, { outcome: 'worked' })}
              >
                Worked
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onPatch(item.id, { outcome: 'no_response' })}
              >
                No response
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
