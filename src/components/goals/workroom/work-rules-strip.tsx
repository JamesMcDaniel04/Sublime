'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export type SkipNote = { subject: string; note: string }

export type WorkRule = {
  id: string
  statement: string
  /** The same conclusion phrased as an observation. Null on rules learned
   *  before findings existed; the strip falls back to `statement`. */
  finding: string | null
  signal: string
  skippedCount: number
  totalCount: number
  topSkipReason: string | null
  exploreRate: number
  learnedAt: string
  scope: 'agent' | 'org'
  agentName: string | null
}

const REASON_WORDS: Record<string, string> = {
  too_early: 'too early',
  wrong_contact: 'wrong contact',
  wrong_content: 'wrong content',
  already_handled: 'already handled',
  not_relevant: 'not relevant',
  other: 'other',
}

const humanReason = (reason: string) => REASON_WORDS[reason] ?? reason.replace(/_/g, ' ')

/**
 * What the agents have been told to stop doing, and why.
 *
 * These rules change what gets produced without anyone approving them, so the
 * inference and its evidence have to be legible — a system that silently
 * steers agents from conclusions nobody can inspect is not one a team can
 * trust. Turning one off is a shortcut for a person who can already see it is
 * wrong; probes and the unprobed TTL remain the actual lifecycle.
 */
export function WorkRulesStrip({
  rules,
  skipNotes,
  onRevoke,
}: {
  rules: WorkRule[]
  skipNotes: SkipNote[]
  onRevoke: (ruleId: string) => void
}) {
  if (rules.length === 0 && skipNotes.length === 0) return null

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">
        What your team is telling you
      </p>
      <ul className="space-y-2">
        {rules.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm">{rule.finding ?? rule.statement}</p>
              <p className="text-xs text-muted-foreground">
                {rule.skippedCount} of {rule.totalCount} skipped
                {rule.topSkipReason ? `, mostly "${humanReason(rule.topSkipReason)}"` : ''}
                {rule.agentName ? ` · ${rule.agentName}` : ''}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              {rule.scope === 'org' && (
                <Badge variant="outline" className="text-[11px] font-medium">
                  Org-wide
                </Badge>
              )}
              <Button size="sm" variant="ghost" onClick={() => onRevoke(rule.id)}>
                Turn off
              </Button>
            </span>
          </li>
        ))}
      </ul>

      {skipNotes.length > 0 && (
        <div className="space-y-1 pt-1">
          <p className="text-xs font-medium text-muted-foreground">In their words</p>
          <ul className="space-y-0.5">
            {skipNotes.map((entry) => (
              <li
                key={`${entry.subject}-${entry.note}`}
                className="text-xs italic text-muted-foreground"
              >
                &ldquo;{entry.note}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
