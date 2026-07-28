'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Database, Pencil, Plug, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export type ListedPostgresConnection = {
  id: string
  name: string
  displayTarget: string
  hasCaCert: boolean
  allowWrites: boolean
  defaultSchema: string
  status: string
  lastError: string | null
  lastUsedAt: string | null
  createdAt: string
}

type Draft = {
  name: string
  connectionString: string
  caCert: string
  allowWrites: boolean
  defaultSchema: string
}

const emptyDraft = (): Draft => ({
  name: '',
  connectionString: '',
  caCert: '',
  allowWrites: false,
  defaultSchema: 'public',
})

/**
 * Manages the org's natively-connected Postgres databases.
 *
 * Rendered in two places from this one component: the /integrations/postgres
 * configuration page, and the in-place connect dialog on the goal wizard —
 * which is why it takes `onConnected` rather than reaching for a router.
 *
 * Reads are always redacted, so an edit shows the stored target and "leave
 * blank to keep" rather than a masked value it could not repopulate anyway.
 */
export function PostgresConnectionsPanel({
  isAdmin = true,
  onConnected,
  compact = false,
}: {
  isAdmin?: boolean
  /** Fired after a connection is created, tested, or deleted. */
  onConnected?: (connections: ListedPostgresConnection[]) => void
  /** Trims chrome for the dialog presentation. */
  compact?: boolean
}) {
  const [rows, setRows] = useState<ListedPostgresConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (notify = false) => {
    try {
      const response = await fetch('/api/postgres/connections')
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not load databases.')
      const connections: ListedPostgresConnection[] = body.connections ?? []
      setRows(connections)
      if (notify) onConnected?.(connections)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load databases.')
    } finally {
      setLoading(false)
    }
  }, [onConnected])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const editing = Boolean(editingId)
      const response = await fetch(
        editing ? `/api/postgres/connections/${editingId}` : '/api/postgres/connections',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.name,
            // Blank on edit means "keep the stored connection string".
            ...(draft.connectionString ? { connectionString: draft.connectionString } : {}),
            ...(draft.caCert || editing ? { caCert: draft.caCert } : {}),
            allowWrites: draft.allowWrites,
            defaultSchema: draft.defaultSchema,
          }),
        },
      )
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save the database connection.')
      const status = body.connection?.status
      if (status === 'error') {
        toast.warning(`Saved “${draft.name}”, but it could not be reached yet.`, {
          description: body.connection?.lastError ?? undefined,
        })
      } else {
        toast.success(`“${draft.name}” connected.`)
      }
      setDraft(null)
      setEditingId(null)
      await load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the database connection.')
    } finally {
      setSaving(false)
    }
  }

  const test = async (row: ListedPostgresConnection) => {
    setBusyId(row.id)
    try {
      const response = await fetch(`/api/postgres/connections/${row.id}/test`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not reach the database.')
      if (body.status === 'connected') toast.success(`“${row.name}” is reachable.`)
      else toast.error(body.error || `“${row.name}” could not be reached.`)
      await load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not reach the database.')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (row: ListedPostgresConnection) => {
    if (!window.confirm(`Disconnect “${row.name}”? Agents and goals using it will stop reading from it.`)) return
    setBusyId(row.id)
    try {
      const response = await fetch(`/api/postgres/connections/${row.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || 'Could not disconnect the database.')
      }
      toast.success(`“${row.name}” disconnected.`)
      await load(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not disconnect the database.')
    } finally {
      setBusyId(null)
    }
  }

  if (draft) {
    const editing = Boolean(editingId)
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="pg-name">Name</Label>
          <Input
            id="pg-name"
            value={draft.name}
            placeholder="Production DB"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">How this database appears to you and to your agents.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pg-connection">Connection string</Label>
          <Input
            id="pg-connection"
            type="password"
            autoComplete="off"
            value={draft.connectionString}
            placeholder={editing ? 'Unchanged — leave blank to keep the stored one' : 'postgres://user:password@host:5432/database'}
            onChange={(event) => setDraft({ ...draft, connectionString: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Stored encrypted and never shown again. Use a read-only role unless you intend to enable writes.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pg-schema">Default schema</Label>
          <Input
            id="pg-schema"
            value={draft.defaultSchema}
            placeholder="public"
            onChange={(event) => setDraft({ ...draft, defaultSchema: event.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pg-ca">CA certificate (optional)</Label>
          <Textarea
            id="pg-ca"
            rows={3}
            value={draft.caCert}
            placeholder="-----BEGIN CERTIFICATE-----"
            onChange={(event) => setDraft({ ...draft, caCert: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            TLS is verified and cannot be turned off. If your database uses a private CA, paste its certificate here.
          </p>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 p-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Allow writes</p>
            <p className="text-xs text-muted-foreground">
              Off: agents can only read. On: they may also run INSERT/UPDATE/DELETE — never schema changes, and every
              write pauses for your approval before it runs.
            </p>
          </div>
          <Switch
            checked={draft.allowWrites}
            onCheckedChange={(allowWrites) => setDraft({ ...draft, allowWrites })}
            aria-label="Allow writes to this database"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => { setDraft(null); setEditingId(null) }} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!draft.name.trim() || (!editing && !draft.connectionString.trim())}
          >
            {editing ? 'Save changes' : 'Connect database'}
          </Button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 2 }, (_, i) => <Skeleton key={`pg-skeleton-${i}`} className="h-20 rounded-xl" />)}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex justify-end">
          <Button onClick={() => setDraft(emptyDraft())} disabled={!isAdmin}>
            <Plus className="mr-2 h-4 w-4" />Add database
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No databases connected"
          description="Connect a Postgres database so agents, flows, and goals can read from it."
          action={
            isAdmin ? (
              <Button onClick={() => setDraft(emptyDraft())}>
                <Plus className="mr-2 h-4 w-4" />Add database
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {row.name}
                  {row.status === 'connected' && (
                    <Badge variant="good"><Check className="mr-1 h-3 w-3" />Verified</Badge>
                  )}
                  {row.status === 'error' && (
                    <Badge variant="destructive"><AlertTriangle className="mr-1 h-3 w-3" />Unreachable</Badge>
                  )}
                  {row.status === 'untested' && <Badge variant="secondary">Untested</Badge>}
                  <Badge variant={row.allowWrites ? 'outline' : 'secondary'} className="text-[10px]">
                    {row.allowWrites ? 'Writes enabled' : 'Read-only'}
                  </Badge>
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {row.displayTarget}
                  {row.defaultSchema !== 'public' && ` · schema ${row.defaultSchema}`}
                  {row.hasCaCert && ' · private CA'}
                </p>
                {row.lastError && <p className="text-xs text-red-600">{row.lastError}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => void test(row)} loading={busyId === row.id}>
                  <Plug className="mr-1.5 h-3.5 w-3.5" />Test
                </Button>
                {isAdmin && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit ${row.name}`}
                      onClick={() => {
                        setEditingId(row.id)
                        setDraft({
                          name: row.name,
                          connectionString: '',
                          caCert: '',
                          allowWrites: row.allowWrites,
                          defaultSchema: row.defaultSchema,
                        })
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Disconnect ${row.name}`}
                      onClick={() => void remove(row)}
                      disabled={busyId === row.id}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-600" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {compact && (
        <Button variant="outline" className="w-full" onClick={() => setDraft(emptyDraft())} disabled={!isAdmin}>
          <Plus className="mr-2 h-4 w-4" />Add database
        </Button>
      )}

      {!isAdmin && (
        <p className="text-xs text-muted-foreground">Only workspace admins can add or change database connections.</p>
      )}
    </div>
  )
}
