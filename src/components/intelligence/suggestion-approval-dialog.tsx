'use client'

/**
 * Approve/deny dialog for the user's one open evidence-backed suggestion.
 * Opened from an `intelligence.user-suggestion` notification: fetches the
 * open suggestion, renders its "why this exists" evidence trail, and lands
 * the user on the changed thing (draft flow / enhanced flow / agent config)
 * on approval. Denial feeds the dismissal-learning loop server-side.
 */
import { useEffect, useState } from 'react'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export type OpenUserSuggestion = {
  id: string
  kind: 'new_flow' | 'enhancement' | 'goal_action'
  title: string
  description: string
  flowId: string | null
  targetType: string | null
  targetId: string | null
  evidence: string[]
  metadata?: {
    goalId?: string
    seedKey?: string | null
  }
}

type Props = {
  open: boolean
  onClose: () => void
  /** Called after the suggestion is approved or denied (e.g. to clear the
   *  originating notification row). */
  onActioned?: (action: 'accept' | 'dismiss') => void
}

/** Where an approved suggestion lands the user: the thing that changed. */
function acceptedDestination(s: OpenUserSuggestion): string | null {
  if (s.flowId) return `/flows/${s.flowId}`
  if (s.targetType === 'flow' && s.targetId) return `/flows/${s.targetId}`
  if (s.targetType === 'agent' && s.targetId) return `/agents?agent=${s.targetId}`
  if (s.targetType === 'goal' && s.targetId) return `/goals/${s.targetId}`
  return null
}

export function SuggestionApprovalDialog({ open, onClose, onActioned }: Readonly<Props>) {
  const router = useScopedRouter()
  const [suggestion, setSuggestion] = useState<OpenUserSuggestion | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setSuggestion(null)
    void (async () => {
      try {
        const response = await fetch('/api/intelligence/user-suggestions', { cache: 'no-store' })
        const data = await response.json().catch(() => ({}))
        if (!cancelled) setSuggestion((data?.suggestion as OpenUserSuggestion) ?? null)
      } catch {
        if (!cancelled) setSuggestion(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  const act = async (action: 'accept' | 'dismiss', activate = false) => {
    if (!suggestion || busy) return
    setBusy(true)
    try {
      const deployGoalRecommendation =
        action === 'accept' && suggestion.kind === 'goal_action' && Boolean(suggestion.metadata?.seedKey)
      const response = await fetch(
        deployGoalRecommendation ? '/api/templates/provision' : '/api/intelligence/user-suggestions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            deployGoalRecommendation
              ? {
                  seedKey: suggestion.metadata?.seedKey,
                  goalId: suggestion.metadata?.goalId ?? suggestion.targetId,
                  suggestionId: suggestion.id,
                  activate: false,
                }
              : { id: suggestion.id, action, activate },
          ),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'request failed')
      onActioned?.(action)
      onClose()
      if (action !== 'accept') return
      if (deployGoalRecommendation) {
        toast.success('Recommendation deployed and linked to the goal.')
        if (data.kind === 'flow' && data.flowId) router.push(`/flows/${data.flowId}`)
        else if (data.agentId) router.push(`/agents?agent=${data.agentId}`)
        return
      }
      if (activate) {
        if (data.activated) toast.success('Approved — the flow is live.')
        else toast.info('Approved as a draft — it needs a quick review before it can go live.')
      }
      // Approving always lands the user ON the thing that changed: the draft
      // flow, the enhanced flow, or the enhanced agent's config (where the
      // suggestion banner now shows it).
      const destination = acceptedDestination(suggestion)
      if (destination) router.push(destination)
      else toast.success('Suggestion saved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the suggestion. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {suggestion?.kind === 'goal_action' ? 'Sublime noticed goal risk' : 'Sublime noticed a routine'}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading suggestion…</p>
        ) : !suggestion ? (
          <p className="text-sm text-muted-foreground">This suggestion has already been handled — nothing is waiting for review.</p>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="font-medium text-foreground">{suggestion.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{suggestion.description}</p>
            </div>
            {suggestion.evidence.length > 0 && (
              <div className="rounded-lg border bg-muted p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-indigo-500">Why this exists</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {suggestion.evidence.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" disabled={busy} onClick={() => void act('dismiss')}>
                Deny
              </Button>
              {suggestion.kind === 'new_flow' && suggestion.flowId ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={() => void act('accept')}>
                    Approve & review draft
                  </Button>
                  <Button loading={busy} onClick={() => void act('accept', true)}>
                    Approve & activate
                  </Button>
                </>
              ) : suggestion.kind === 'goal_action' && suggestion.metadata?.seedKey ? (
                <Button loading={busy} onClick={() => void act('accept')}>
                  Deploy recommendation
                </Button>
              ) : (
                <Button loading={busy} onClick={() => void act('accept')}>
                  Approve
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
