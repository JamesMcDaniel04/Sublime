'use client'

import { useEffect, useState } from 'react'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

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
  isOwner,
  onView,
  onRestore,
  onClose,
}: {
  flowId: string
  currentVersion: number
  /** Owner-only actions (delete a snapshot) render only when true. */
  isOwner?: boolean
  onView: (version: number) => void
  onRestore: (version: number) => void
  onClose: () => void
}) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [editingVersion, setEditingVersion] = useState<number | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [busyVersion, setBusyVersion] = useState<number | null>(null)

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

  const saveNote = async (row: VersionRow) => {
    const note = noteDraft.trim()
    setBusyVersion(row.version)
    try {
      const response = await fetch(`/api/flows/${flowId}/versions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: row.version, note }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not save the note.'); return }
      setVersions((current) => current.map((entry) => entry.version === row.version ? { ...entry, note: note || null } : entry))
      setEditingVersion(null)
    } finally {
      setBusyVersion(null)
    }
  }

  const deleteVersion = async (row: VersionRow) => {
    if (!window.confirm(`Delete the v${row.version} snapshot from history? The published flow keeps running; only this restore point is removed.`)) return
    setBusyVersion(row.version)
    try {
      const response = await fetch(`/api/flows/${flowId}/versions?version=${row.version}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not delete the snapshot.'); return }
      setVersions((current) => current.filter((entry) => entry.version !== row.version))
      toast.success(`Deleted the v${row.version} snapshot.`)
    } finally {
      setBusyVersion(null)
    }
  }

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
            const busy = busyVersion === row.version
            return (
              <div
                key={row.id}
                className={cn('border-b border-border/60 px-3 py-2.5 last:border-0', isCurrent && 'bg-muted/40')}
              >
                <div className="flex items-center gap-2">
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Edit v${row.version} note`}
                    disabled={busy}
                    onClick={() => {
                      setEditingVersion(editingVersion === row.version ? null : row.version)
                      setNoteDraft(row.note ?? '')
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-600 hover:text-red-700"
                      aria-label={`Delete v${row.version} snapshot`}
                      disabled={busy}
                      onClick={() => void deleteVersion(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {editingVersion === row.version && (
                  <form
                    className="mt-2 flex items-center gap-2"
                    onSubmit={(event) => { event.preventDefault(); void saveNote(row) }}
                  >
                    <Input
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      maxLength={200}
                      placeholder="What changed in this version?"
                      className="h-8 text-xs"
                      autoFocus
                    />
                    <Button type="submit" size="icon" variant="outline" className="h-8 w-8" aria-label="Save note" loading={busy} disabled={busy}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                  </form>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
