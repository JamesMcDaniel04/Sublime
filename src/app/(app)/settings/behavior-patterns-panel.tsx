'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type PatternRow = {
  slug: string
  kind: string
  summary: string
  occurrenceCount: number
  firstSeenAt: string
  lastSeenAt: string
  eligible: boolean
}

type Persona = { narrative: string | null; topDepartments: string[]; computedAt: string } | null

const KIND_LABELS: Record<string, string> = {
  sequence: 'Routine sequence',
  temporal: 'Time-of-week routine',
  friction: 'Friction',
  intent: 'Recurring intent',
  tool_correlation: 'Tools used together',
  capability_gap: 'Unused capability',
  peer_practice: 'Teammate practice',
  archetype_gap: 'Common elsewhere',
  commitment: 'Meeting commitment',
}

// Rendered on /settings under the org-level learnings panel: the PER-USER
// leg of the transparency view — the behavior patterns Sublime has mined
// from this user's own usage, visible BEFORE any of them grounds a
// suggestion. Dismissing here feeds the same similarity-suppression loop a
// suggestion dismissal does, one step earlier.
export function BehaviorPatternsPanel() {
  const [patterns, setPatterns] = useState<PatternRow[] | null>(null)
  const [persona, setPersona] = useState<Persona>(null)
  const [dismissingSlug, setDismissingSlug] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/intelligence/patterns', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error)
      setPatterns(Array.isArray(data.patterns) ? data.patterns : [])
      setPersona(data.persona ?? null)
    } catch {
      setPatterns([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dismiss = async (slug: string) => {
    setDismissingSlug(slug)
    try {
      const response = await fetch('/api/intelligence/patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not dismiss this pattern.')
        return
      }
      setPatterns((prev) => (prev ?? []).filter((pattern) => pattern.slug !== slug))
      toast.success('Pattern dismissed — similar ones are suppressed too.')
    } finally {
      setDismissingSlug(null)
    }
  }

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>What Sublime has learned about how you work</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {persona?.narrative && (
          <div className="rounded-lg border bg-muted p-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-indigo-500">Workspace persona</p>
            <p className="mt-1 text-muted-foreground">{persona.narrative}</p>
            {persona.topDepartments.length > 0 && (
              <p className="mt-1.5 text-xs capitalize text-muted-foreground">Leaning: {persona.topDepartments.join(', ')}</p>
            )}
          </div>
        )}
        {patterns === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : patterns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No behavior patterns yet. As you run agents, flows, and connected tools, Sublime mines
            well-evidenced routines here — each one is visible (and dismissible) before it ever
            grounds a suggestion.
          </p>
        ) : (
          <ul className="space-y-2">
            {patterns.map((pattern) => (
              <li key={pattern.slug} className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                <Activity className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{KIND_LABELS[pattern.kind] ?? pattern.kind}</Badge>
                    {pattern.eligible
                      ? <Badge>Can ground suggestions</Badge>
                      : <Badge variant="outline">Still gathering evidence</Badge>}
                  </div>
                  <p className="mt-1.5">{pattern.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Observed {pattern.occurrenceCount} time{pattern.occurrenceCount === 1 ? '' : 's'}, most recently{' '}
                    {new Date(pattern.lastSeenAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Dismiss pattern: ${pattern.summary}`}
                  title="Dismiss — Sublime stops suggesting from this pattern"
                  disabled={dismissingSlug === pattern.slug}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  onClick={() => void dismiss(pattern.slug)}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
