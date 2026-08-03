'use client'

import { useState } from 'react'
import { ChevronDown, Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RunVerdictSummary } from '@/lib/types'

/**
 * Run→goal contribution funnel: reflection's judgment of whether the runs
 * serving this goal actually advanced it, over the last 30 days. This is the
 * surface the "agent has stopped advancing this goal" notification lands on —
 * it must explain itself without the reader knowing what a verdict is.
 *
 * Renders nothing when the goal has no judged runs: an empty funnel reads as
 * "tracking is on and found nothing", which would be a lie.
 */

const VERDICT_META: Record<
  keyof RunVerdictSummary['counts'],
  { label: string; dot: string }
> = {
  advanced: { label: 'Advanced the goal', dot: 'bg-emerald-500' },
  no_change: { label: 'No change', dot: 'bg-amber-400' },
  counterproductive: { label: 'Counterproductive', dot: 'bg-red-500' },
  unclear: { label: 'Unclear', dot: 'bg-muted-foreground/40' },
}

const ORDER: Array<keyof RunVerdictSummary['counts']> = [
  'advanced',
  'no_change',
  'counterproductive',
  'unclear',
]

export function VerdictFunnel({ verdicts }: { verdicts: RunVerdictSummary | null }) {
  const [expanded, setExpanded] = useState(false)
  if (!verdicts) return null
  const total = ORDER.reduce((sum, key) => sum + verdicts.counts[key], 0)
  if (total === 0) return null

  return (
    <div className="rounded-2xl border bg-card p-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Run contribution</h3>
        <span className="text-xs text-muted-foreground">
          · {total} run{total === 1 ? '' : 's'} judged in the last 30 days
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Stacked proportion bar + per-verdict counts. */}
      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {ORDER.map((key) =>
          verdicts.counts[key] > 0 ? (
            <div
              key={key}
              className={VERDICT_META[key].dot}
              style={{ width: `${(verdicts.counts[key] / total) * 100}%` }}
              title={`${VERDICT_META[key].label}: ${verdicts.counts[key]}`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {ORDER.map((key) =>
          verdicts.counts[key] > 0 ? (
            <span key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn('h-2 w-2 rounded-full', VERDICT_META[key].dot)} />
              {VERDICT_META[key].label} · {verdicts.counts[key]}
            </span>
          ) : null,
        )}
      </div>

      {expanded && (
        <ul className="mt-3 space-y-2 border-t pt-3">
          {verdicts.recent.map((row) => (
            <li key={row.id} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  'mt-1 h-2 w-2 shrink-0 rounded-full',
                  VERDICT_META[row.verdict]?.dot ?? 'bg-muted-foreground/40',
                )}
              />
              <div className="min-w-0">
                <span className="font-medium">
                  {VERDICT_META[row.verdict]?.label ?? row.verdict}
                </span>{' '}
                <span className="text-muted-foreground">
                  · {row.resourceType} run · {new Date(row.createdAt).toLocaleDateString()}
                </span>
                {row.evidence && (
                  <p className="mt-0.5 text-muted-foreground">{row.evidence}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
