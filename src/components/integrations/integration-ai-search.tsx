'use client'

import { FormEvent, useState } from 'react'
import { Loader2, Search, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { IntegrationMatch, IntegrationSearchItem } from '@/lib/integrations/ai-search'

export function IntegrationAiSearch({
  items,
  query,
  onQueryChange,
  onRecommendations,
}: {
  items: IntegrationSearchItem[]
  query: string
  onQueryChange: (query: string) => void
  onRecommendations: (matches: IntegrationMatch[] | null) => void
}) {
  const [matches, setMatches] = useState<IntegrationMatch[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const names = new Map(items.map((item) => [item.id, item.name]))

  const change = (value: string) => {
    onQueryChange(value)
    setMatches(null)
    onRecommendations(null)
    setError('')
  }

  const recommend = async (event: FormEvent) => {
    event.preventDefault()
    if (query.trim().length < 3 || !items.length) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/integrations/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), items }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not generate recommendations.')
      const next = (data.matches ?? []) as IntegrationMatch[]
      setMatches(next)
      onRecommendations(next)
      if (!next.length) setError('No strong matches found. Try describing the apps or workflow in more detail.')
    } catch (caught) {
      // The input remains a useful normal search when no model is configured.
      setError(caught instanceof Error ? `${caught.message} Showing text matches instead.` : 'Showing text matches instead.')
      setMatches(null)
      onRecommendations(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/80 to-background p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Sparkles className="h-4 w-4 text-indigo-600" /> Find the right integrations</p>
        <p className="mt-1 text-xs text-slate-500">Describe what you want to accomplish and AI will recommend the tools to connect.</p>
      </div>
      <form onSubmit={recommend} className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(event) => change(event.target.value)}
            placeholder="e.g. Triage support tickets and alert the team"
            className="bg-background pl-9 pr-9"
          />
          {query && <button type="button" onClick={() => change('')} aria-label="Clear integration search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"><X className="h-4 w-4" /></button>}
        </div>
        <Button type="submit" disabled={loading || query.trim().length < 3 || !items.length}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Recommend
        </Button>
      </form>
      {matches && matches.length > 0 && (
        <div className="grid gap-2 md:grid-cols-2">
          {matches.map((match) => <div key={match.id} className="rounded-lg border bg-card px-3 py-2"><p className="text-sm font-medium text-slate-900">{names.get(match.id)}</p><p className="text-xs text-slate-500">{match.reason}</p></div>)}
        </div>
      )}
      {error && <p className="text-xs text-amber-700">{error}</p>}
    </div>
  )
}
