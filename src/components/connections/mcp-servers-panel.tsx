'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Plug, Plus, Server, Trash2 } from 'lucide-react'
import { McpConnectionDialog, type McpConnectionDraft, type SerializedConnection } from './mcp-connection-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useScanExclusions } from '@/lib/client/use-scan-exclusions'
import { connectionSourceRef } from '@/lib/intelligence/scan-exclusions'
import { CachedJsonError, getCachedJson, invalidateCachedJson, useCachedJson } from '@/lib/client/use-cached-json'

// ── Auth-badge labels ─────────────────────────────────────────────────────────

const authLabels: Record<string, string> = {
  none: 'None',
  api_key: 'API key',
  oauth2: 'OAuth 2.0',
}

// ── Main component ────────────────────────────────────────────────────────────
// Rendered as the "MCP Servers" tab on /integrations (the old standalone
// /connections page now redirects there).

function McpServersPanelInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [connections, setConnections] = useState<SerializedConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<SerializedConnection | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [togglingLearningId, setTogglingLearningId] = useState<string | null>(null)
  const [rescanningId, setRescanningId] = useState<string | null>(null)
  const { isLearningEnabled, setLearningEnabled } = useScanExclusions()
  // The underlying write is PATCH /api/organizations (settings:workspace), so
  // gate the switch like the Nango grid does — a member flipping it only got
  // a generic failure toast and a reverting switch.
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

  const load = useCallback(async (force = false) => {
    if (force) invalidateCachedJson('/api/mcp-connections')
    try {
      const data = await getCachedJson<{ connections?: SerializedConnection[] }>('/api/mcp-connections')
      setConnections(data.connections || [])
      setAuthError(null)
      setAuthStatus(null)
    } catch (error) {
      setAuthStatus(error instanceof CachedJsonError ? error.status : null)
      setAuthError(error instanceof Error ? error.message : 'Could not load connections.')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load().catch(() => setLoading(false))
  }, [load])

  useEffect(() => {
    const connected = searchParams.get('connected')
    const oauthError = searchParams.get('error')
    if (connected === '1') toast.success('MCP server connected.')
    if (oauthError) toast.error('MCP authorization did not complete. Try connecting again.')
    if (connected || oauthError) router.replace('/integrations?tab=mcp', { scroll: false })
  }, [router, searchParams])

  const saveConnection = async (draft: McpConnectionDraft) => {
    // Build the payload — omit secret fields that are blank on edit
    // (the server preserves existing encrypted secrets for omitted fields)
    const payload: Record<string, unknown> = {
      name: draft.name,
      description: draft.description || undefined,
      serverUrl: draft.serverUrl,
      authType: draft.authType,
    }

    if (draft.authType === 'api_key') {
      if (draft.credentialId) payload.credentialId = draft.credentialId
      if (draft.headerName) payload.headerName = draft.headerName
    }
    if (draft.authType === 'oauth2') {
      if (draft.clientId) payload.clientId = draft.clientId
      if (draft.clientSecret) payload.clientSecret = draft.clientSecret
      if (draft.tokenUrl) payload.tokenUrl = draft.tokenUrl
      if (draft.scopes) payload.scopes = draft.scopes
    }

    if (editingConnection) {
      payload.id = editingConnection.id
    }

    const response = await fetch('/api/mcp-connections', {
      method: editingConnection ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data.error || `Failed to save (HTTP ${response.status}).`
      toast.error(message)
      throw new Error(message)
    }

    setEditingConnection(null)
    toast.success(editingConnection ? 'Server updated.' : 'Server added.')
    await load(true)
  }

  const toggleActive = async (conn: SerializedConnection) => {
    const response = await fetch('/api/mcp-connections', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conn.id, isActive: !conn.isActive }),
    })
    if (response.ok) {
      await load(true)
    } else {
      toast.error('Failed to update status.')
    }
  }

  const deleteConnection = async (conn: SerializedConnection) => {
    setDeletingId(conn.id)
    try {
      const response = await fetch('/api/mcp-connections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: conn.id }),
      })
      if (response.ok) {
        toast.success(`"${conn.name}" removed.`)
        await load(true)
      } else {
        toast.error('Failed to delete.')
      }
    } finally {
      setDeletingId(null)
    }
  }

  const toggleLearning = async (conn: SerializedConnection, enabled: boolean) => {
    setTogglingLearningId(conn.id)
    try {
      const ok = await setLearningEnabled(connectionSourceRef('mcp', conn.id), enabled)
      if (!ok) toast.error('Could not update learning setting.')
    } finally {
      setTogglingLearningId(null)
    }
  }

  const rescan = async (conn: SerializedConnection) => {
    setRescanningId(conn.id)
    try {
      const response = await fetch('/api/intelligence/rescan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plane: 'mcp', connectionRef: conn.id, connectionName: conn.name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not rescan this server.')
      toast.success('Connection scan complete.')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not rescan this server.') }
    finally { setRescanningId(null) }
  }

  const openAdd = () => {
    setEditingConnection(null)
    setDialogOpen(true)
  }

  const openEdit = (conn: SerializedConnection) => {
    setEditingConnection(conn)
    setDialogOpen(true)
  }

  return (
    <>
      <div className="space-y-6">
        {/* Tab header row (the page-level header lives on /integrations) */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Connect external Model Context Protocol servers to your agents.
          </p>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Add MCP server
          </Button>
        </div>

        {/* Auth error */}
        {authError && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {authStatus === 401 ? (
                <>
                  <p className="font-medium">You&apos;re not signed in.</p>
                  <p className="mb-2 text-amber-800">Sign in to manage your MCP connections.</p>
                  <Button size="sm" onClick={() => router.push('/auth/login')}>
                    Sign in
                  </Button>
                </>
              ) : authStatus === 403 ? (
                <>
                  <p className="font-medium">Your workspace is still provisioning.</p>
                  <p className="text-amber-800">Reload in a moment.</p>
                </>
              ) : (
                <p className="font-medium">{authError}</p>
              )}
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !authError && connections.length === 0 && (
          <EmptyState
            icon={Server}
            title="No MCP servers yet"
            description="Add a server to give your agents access to external tools."
            action={
              <Button variant="outline" onClick={openAdd}>
                <Plus className="h-4 w-4" />
                Add your first server
              </Button>
            }
          />
        )}

        {/* Connection cards */}
        {!loading && connections.length > 0 && (
          <div className="stagger-children grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-1 transition-all duration-base ease-out-quart hover:-translate-y-px hover:shadow-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Plug className="h-4 w-4 shrink-0 text-indigo-500" />
                      <span className="truncate font-medium text-sm">{conn.name}</span>
                    </div>
                    {conn.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {conn.description}
                      </p>
                    )}
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    {authLabels[conn.auth.authType] ?? conn.auth.authType}
                  </Badge>
                </div>

                <p className="truncate text-xs text-muted-foreground" title={conn.serverUrl}>
                  {conn.serverUrl}
                </p>

                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  {conn.provider ? (
                    <>
                      {conn.isActive ? (
                        <Badge variant="good" className="text-xs">Active</Badge>
                      ) : (
                        <Badge variant="warn" className="text-xs">Needs authorization</Badge>
                      )}
                      <a
                        href={`/api/mcp-connections/oauth/start?connectionId=${conn.id}&returnTo=/connections`}
                        className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-background px-2 text-xs font-medium shadow-1 transition-all duration-fast ease-out-quart hover:border-graphite-300 hover:bg-accent hover:text-accent-foreground"
                      >
                        Reauthorize
                      </a>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={conn.isActive}
                          onCheckedChange={() => toggleActive(conn)}
                          aria-label={conn.isActive ? 'Disable server' : 'Enable server'}
                        />
                        {conn.isActive ? (
                          <Badge variant="good" className="text-xs">Active</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">Inactive</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => openEdit(conn)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          disabled={deletingId === conn.id}
                          onClick={() => deleteConnection(conn)}
                          aria-label="Delete server"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <Button size="sm" variant="ghost" loading={rescanningId === conn.id} disabled={rescanningId !== null || !conn.isActive} onClick={() => void rescan(conn)}>Rescan</Button>
                  <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Learning</span><Switch checked={isLearningEnabled(connectionSourceRef('mcp', conn.id))} disabled={togglingLearningId === conn.id || !isAdmin} onCheckedChange={(enabled) => toggleLearning(conn, enabled)} aria-label={isLearningEnabled(connectionSourceRef('mcp', conn.id)) ? 'Disable learning from this server' : 'Enable learning from this server'} /></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <McpConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={saveConnection}
        editingConnection={editingConnection}
      />
    </>
  )
}

export function McpServersPanel() {
  return (
    <Suspense fallback={null}>
      <McpServersPanelInner />
    </Suspense>
  )
}
