'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type VersionRow = {
  id: string
  version: number
  note?: string | null
  publishedAt: string
  publishedBy?: string | null
}

export function VersionsPanel({
  flowId,
  currentVersion,
  onView,
  onRestore,
  onClose,
}: {
  flowId: string
  currentVersion: number
  onView: (version: number) => void
  onRestore: (version: number) => void
  onClose: () => void
}) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    fetch(`/api/flows/${flowId}/versions`, { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok || !data.success) throw new Error(data.error || 'Could not load version history.')
        return data
      })
      .then((data) => {
        if (!cancelled && data.success) setVersions(data.versions)
      })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load version history.') })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [flowId, loadAttempt])

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : loadError ? (
          <div className="p-4 text-sm text-red-700"><p>{loadError}</p><Button className="mt-2" variant="outline" size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>Try again</Button></div>
        ) : versions.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Publish the flow to start its version history.</p>
        ) : (
          versions.map((row) => {
            const isCurrent = row.version === currentVersion
            return (
              <div
                key={row.id}
                className={cn('flex items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-0', isCurrent && 'bg-muted/40')}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">v{row.version}</span>
                    {isCurrent && <Badge variant="secondary">Current</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(row.publishedAt).toLocaleString()}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onView(row.version)}>
                  View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Restore v${row.version} into the draft? Your current draft is replaced (undo with ⌘Z).`)) {
                      onRestore(row.version)
                    }
                  }}
                >
                  Restore
                </Button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
