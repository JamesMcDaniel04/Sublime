'use client'

/**
 * Approve/deny dialog for the user's one open evidence-backed suggestion.
 * Opened from an `intelligence.user-suggestion` notification: fetches the
 * open suggestion, renders its "why this exists" evidence trail, and lands
 * the user on the changed thing (draft flow / enhanced flow / agent config)
 * on approval. Denial feeds the dismissal-learning loop server-side.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export type OpenUserSuggestion = {
  id: string
  kind: 'new_flow' | 'enhancement'
  title: string
  description: string
  flowId: string | null
  targetType: string | null
  targetId: string | null
  evidence: string[]
}

type Props = {
  open: boolean
  onClose: () => void
  /** Called after the suggestion is approved or denied (e.g. to clear the
   *  originating notification row). */
  onActioned?: (action: 'accept' | 'dismiss') => void
}

export function SuggestionApprovalDialog({ open, onClose, onActioned }: Props) {
  const router = useRouter()
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

  const act = async (action: 'accept' | 'dismiss') => {
    if (!suggestion || busy) return
    setBusy(true)
    try {
      const response = await fetch('/api/intelligence/user-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: suggestion.id, action }),
      })
      if (!response.ok) throw new Error('request failed')
      const accepted = action === 'accept'
      const { flowId, targetType, targetId } = suggestion
      onActioned?.(action)
      onClose()
      // Approving always lands the user ON the thing that changed: the draft
      // flow, the enhanced flow, or the enhanced agent's config (where the
      // suggestion banner now shows it).
      if (accepted && flowId) router.push(`/flows/${flowId}`)
      else if (accepted && targetType === 'flow' && targetId) router.push(`/flows/${targetId}`)
      else if (accepted && targetType === 'agent' && targetId) router.push(`/agents?agent=${targetId}`)
      else if (accepted) toast.success('Suggestion saved.')
    } catch {
      toast.error('Could not update the suggestion. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sublime noticed a routine</DialogTitle>
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
              <Button loading={busy} onClick={() => void act('accept')}>
                {suggestion.kind === 'new_flow' ? 'Approve & review draft' : 'Approve'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
