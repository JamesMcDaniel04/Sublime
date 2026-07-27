'use client'

import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import type { CopilotDraft } from '@/lib/goals/copilot'

const EXAMPLES = [
  'Reach $2M ARR by the end of the year',
  'Grow demo bookings and the revenue they convert to',
  'Cut our monthly cloud spend 20% this quarter',
  'Book 120 qualified leads a month for the sales team',
]

export function GoalCopilot({
  onDraft,
}: {
  onDraft: (draft: CopilotDraft, notes: string[]) => void
}) {
  const [description, setDescription] = useState('')
  const [drafting, setDrafting] = useState(false)

  const draft = async () => {
    if (!description.trim()) return
    setDrafting(true)
    try {
      const response = await fetch('/api/goals/copilot/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      })
      const body = await response.json()
      if (!response.ok) {
        throw new Error(
          body.error || 'The Copilot could not draft this right now.',
        )
      }
      onDraft(body.draft, body.notes ?? [])
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'The Copilot could not draft this right now.',
      )
    } finally {
      setDrafting(false)
    }
  }

  return (
    <Card className="space-y-4 border-chart-violet/30 p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-chart-violet" />
        <div>
          <h2 className="font-semibold">Describe your goal</h2>
          <p className="text-sm text-muted-foreground">
            The Copilot designs a dashboard to track it — you review
            everything before it exists.
          </p>
        </div>
      </div>
      <Textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Describe what you want to achieve…"
        className="min-h-24"
        maxLength={2000}
        disabled={drafting}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setDescription(example)}
              className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
        <Button
          onClick={draft}
          disabled={drafting || !description.trim()}
        >
          {drafting
            ? 'Designing your dashboard…'
            : 'Design my dashboard'}
        </Button>
      </div>
    </Card>
  )
}
