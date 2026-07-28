'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export type WorkRule = {
  id: string
  statement: string
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
  onRevoke,
}: {
  rules: WorkRule[]
  onRevoke: (ruleId: string) => void
}) {
  if (rules.length === 0) return null

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">
        What your agents learned to skip
      </p>
      <ul className="space-y-2">
        {rules.map((rule) => (
          <li key={rule.id} className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm">{rule.statement}</p>
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
    </div>
  )
}
