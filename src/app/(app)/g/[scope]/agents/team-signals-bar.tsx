'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, UserPlus } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'
import { teamIssues, type TeamIssue, type TeamMember } from '@/lib/agents/team-signals'

/**
 * What the roster tells you before you read the tiles.
 *
 * Two strands, because a team page is opened with two questions. On the left,
 * teammates that need something — blocked on an answer, failing, or hired and
 * never run. On the right, candidates worth reviewing, since a library of 84
 * templates behind a tab is a library nobody opens.
 *
 * The whole bar disappears when there is nothing to say. A permanently present
 * "everything is fine" strip trains people to stop reading the one place
 * problems appear.
 */

const ISSUE_TONE: Record<TeamIssue['kind'], string> = {
  waiting: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  failing: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  never_run: 'border-border bg-muted/60 text-muted-foreground',
}

interface Candidate {
  id: string
  name: string
  category?: string
  description?: string
}

/** How many of each strand fit before the bar becomes its own scrolling list. */
const MAX_ISSUES = 4
const MAX_CANDIDATES = 3

export function TeamSignalsBar({
  members,
  onOpenAgent,
  onBrowseTemplates,
}: {
  members: TeamMember[]
  onOpenAgent: (agentId: string) => void
  onBrowseTemplates: () => void
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([])

  useEffect(() => {
    let cancelled = false
    // The shared cache: the sidebar already warms this, so the bar usually
    // costs nothing.
    getCachedJson<{ templates?: Candidate[] }>('/api/agent-templates')
      .then((data) => { if (!cancelled) setCandidates((data.templates ?? []).slice(0, MAX_CANDIDATES)) })
      .catch(() => {
        // A failed lookup hides the candidates strand rather than showing an
        // error: this bar is a prompt, not a feature someone is depending on.
      })
    return () => { cancelled = true }
  }, [])

  const issues = teamIssues(members)
  const shown = issues.slice(0, MAX_ISSUES)

  // Nothing to say means no bar at all.
  if (issues.length === 0 && candidates.length === 0) return null

  return (
    <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* Needs attention */}
      <section className="rounded-xl border bg-card p-3" aria-labelledby="team-needs-attention">
        <h2 id="team-needs-attention" className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          Needs attention
          {issues.length > 0 && <span className="font-normal">({issues.length})</span>}
        </h2>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everyone is working.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((issue) => (
              <li key={`${issue.kind}:${issue.agentId}`}>
                <button
                  type="button"
                  onClick={() => onOpenAgent(issue.agentId)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring',
                    ISSUE_TONE[issue.kind],
                  )}
                >
                  <span className="max-w-[14rem] truncate font-medium">{issue.name}</span>
                  <span className="opacity-80">— {issue.label}</span>
                </button>
              </li>
            ))}
            {issues.length > shown.length && (
              <li className="self-center text-xs text-muted-foreground">
                +{issues.length - shown.length} more
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Candidates */}
      <section className="rounded-xl border bg-card p-3" aria-labelledby="team-candidates">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="team-candidates" className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Candidates
          </h2>
          <button
            type="button"
            onClick={onBrowseTemplates}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Review all <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to review right now.</p>
        ) : (
          <ul className="space-y-1">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={onBrowseTemplates}
                  className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-medium">{candidate.name}</span>
                  {candidate.category && (
                    <span className="shrink-0 text-xs text-muted-foreground">{candidate.category}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
