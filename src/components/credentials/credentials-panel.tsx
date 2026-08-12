'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { CredentialEditor } from './credential-editor'
import { TYPE_LABELS, draftFromRedacted, type CredentialDraft } from '@/lib/credentials/form'
import type { CredentialType, RedactedCredential } from '@/lib/credentials/types'
import { VerificationBadge, type VerificationView } from '@/components/flows/nodes/verification-badge'

export type ListedCredential = {
  id: string
  name: string
  type: string
  allowedDomains: string[]
  createdBy: { id: string; name: string | null } | null
  lastUsedAt: string | null
  config: RedactedCredential
  verification?: VerificationView
}

/**
 * The credential vault manager, rendered as the "Credentials" tab on
 * /integrations. Reads are always redacted — this panel never receives a secret
 * value, which is why editing shows "Unchanged" rather than a masked value it
 * could not repopulate anyway.
 */
export function CredentialsPanel() {
  const [rows, setRows] = useState<ListedCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<{ id: string; draft: CredentialDraft } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/credentials')
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not load credentials.')
      setRows(body.credentials ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load credentials.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const remove = async (row: ListedCredential) => {
    setDeletingId(row.id)
    try {
      const response = await fetch(`/api/credentials/${row.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete the credential.')
      toast.success(`“${row.name}” deleted.`)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the credential.')
    } finally {
      setDeletingId(null)
    }
  }

  if (creating || editing) {
    return (
      <div className="max-w-2xl rounded-xl border border-border bg-card p-4">
        <h3 className="mb-4 text-sm font-semibold">{editing ? `Edit “${rows.find((row) => row.id === editing.id)?.name ?? ''}”` : 'New credential'}</h3>
        <CredentialEditor
          credentialId={editing?.id}
          initial={editing?.draft}
          onSaved={() => { setCreating(false); setEditing(null); void load() }}
          onCancel={() => { setCreating(false); setEditing(null) }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Save an API credential once and anyone in this workspace can attach it to any HTTP step in any flow. Secrets
          are encrypted at rest, injected server-side at request time, and never travel in a flow&apos;s definition, its
          run history, or an export.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> New credential
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }, (_, i) => <Skeleton key={`cred-skeleton-${i}`} className="h-16 rounded-xl" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No saved credentials"
          description="Add one here, then pick it from an HTTP step's Authentication section instead of typing a token into the step."
        />
      ) : (
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm font-medium">
                  {row.name}
                  {row.createdBy?.name && <Badge variant="secondary">Added by {row.createdBy.name}</Badge>}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {TYPE_LABELS[row.type as CredentialType] ?? row.type}
                  {row.allowedDomains.length > 0
                    ? ` · ${row.allowedDomains.join(', ')}`
                    : ' · blocked until a domain is added'}
                  {row.lastUsedAt ? ` · last used ${new Date(row.lastUsedAt).toLocaleDateString()}` : ' · never used'}
                </p>
                {/* The verify endpoint has always recorded this; nothing rendered
                    it, so a credential known to be broken looked healthy here. */}
                {row.verification && <VerificationBadge verification={row.verification} />}
              </div>
              <button
                type="button"
                onClick={() => setEditing({ id: row.id, draft: draftFromRedacted(row) })}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Edit ${row.name}`}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void remove(row)}
                disabled={deletingId === row.id}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                aria-label={`Delete ${row.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
