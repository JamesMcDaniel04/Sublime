'use client'

import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'

type Learning = {
  id: string
  kind: string
  title: string
  content: string
  source: string | null
  createdAt: string
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return value
  }
}

// Rendered on /settings (Workspace tab), under the connection-scanning
// toggle — the "What Sublime has learned" transparency view (Task 4.5).
// Backed by GET/DELETE /api/intelligence/learnings; delete is a soft
// dismiss server-side, so a removed learning never resurfaces.
export function LearningsPanel() {
  const [learnings, setLearnings] = useState<Learning[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const response = await fetch('/api/intelligence/learnings', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load learnings')
      setLearnings(data.learnings)
    } catch (error) {
      setLearnings(null)
      setLoadError(error instanceof Error ? error.message : 'Could not load learnings')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const dismiss = async (id: string) => {
    setDeletingId(id)
    try {
      const response = await fetch(`/api/intelligence/learnings?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not remove learning'); return }
      setLearnings((prev) => (prev ?? []).filter((learning) => learning.id !== id))
      toast.success('Learning removed')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>What Sublime has learned</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Facts and suggestions distilled from your connected tools. Remove anything that shouldn&apos;t be remembered — it won&apos;t resurface.
        </p>
        {learnings === null && !loadError && (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        )}
        {loadError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="font-medium">Learnings could not be loaded</p>
            <p className="mt-1">{loadError}</p>
            <Button type="button" variant="outline" size="sm" className="mt-3 bg-background" onClick={() => void load()}>Try again</Button>
          </div>
        )}
        {learnings !== null && !loadError && learnings.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="Nothing learned yet"
            description="As your team uses connected tools, Sublime distills read-only usage patterns here."
          />
        )}
        {learnings !== null && learnings.length > 0 && (
          <ul className="space-y-2">
            {learnings.map((learning) => (
              <li key={learning.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={learning.kind === 'suggestion' ? 'secondary' : 'outline'} className="text-xs capitalize">
                      {learning.kind}
                    </Badge>
                    {learning.source && <span className="text-xs text-muted-foreground">{learning.source}</span>}
                    <span className="text-xs text-muted-foreground">· {formatDate(learning.createdAt)}</span>
                  </div>
                  <p className="text-sm font-medium">{learning.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{learning.content}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 p-0 text-destructive hover:text-destructive"
                  disabled={deletingId === learning.id}
                  onClick={() => dismiss(learning.id)}
                  aria-label="Remove learning"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
