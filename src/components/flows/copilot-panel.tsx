'use client'

import { useState } from 'react'
import { Sparkles, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { FlowGraph } from '@/lib/flows/graph'

export function CopilotPanel({ onGraph }: { onGraph: (graph: FlowGraph) => void }) {
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)

  const generate = async () => {
    if (!description.trim()) return
    setLoading(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      const data = await response.json()
      if (response.ok && data.graph) {
        const steps = (data.graph.nodes || []).filter((n: { type: string }) => n.type === 'agent').length
        onGraph(data.graph)
        toast.success(steps ? `Drafted ${steps} step${steps === 1 ? '' : 's'} — review before running.` : 'No matching agents found for that description.')
      } else {
        toast.error(data.error || 'Could not generate a flow.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h2 className="text-sm font-semibold">Copilot</h2>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-xs text-muted-foreground">
          Describe what the flow should do and I&apos;ll draft the steps from your agents. Editing them stays up to you.
        </p>
        <textarea
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Pull my in-segment accounts, score each with the Account Scorer, then post the top 20 to #sales."
          className="w-full flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300"
        />
        <Button onClick={generate} loading={loading} disabled={!description.trim()}>
          <Send className="mr-1.5 h-4 w-4" /> Generate
        </Button>
        <p className="text-[11px] text-muted-foreground">AI-generated — replaces the current canvas. Review before running.</p>
      </div>
    </div>
  )
}
