'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Switch } from '@/components/ui/switch'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { IntegrationAiSearch } from '@/components/integrations/integration-ai-search'
import type { IntegrationMatch } from '@/lib/integrations/ai-search'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { useScanExclusions } from '@/lib/client/use-scan-exclusions'
import { connectionSourceRef } from '@/lib/intelligence/scan-exclusions'

type Integration = {
  id: string
  provider: string
  name: string
  logo?: string
  /** The scan-plane delivery capability this integration maps to, if any —
   *  absent means the scan plane never samples it, so there's nothing to
   *  toggle learning for. */
  capability?: string
  /** True when connecting goes through our native Google OAuth flow. */
  native?: boolean
  /** When present, the card opens this configuration page instead of a
   *  Connect flow — for integrations holding several named connections. */
  configPath?: string
}

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  /** Native Google OAuth connection — disconnects via /api/google/oauth. */
  native?: boolean
}

const INTEGRATIONS_PAGE_SIZE = 9

export function OAuthIntegrationsGrid() {
  const router = useRouter()
  // Cached (stale-while-revalidate): the integration catalog is static (also
  // server-cached), connections revalidate in the background. A revisit paints
  // the last-seen grid instantly instead of the loading skeleton. Both persist
  // (scoped, per-tab) so the OAuth full-page redirect returns to the last-seen
  // connected grid instead of an all-disconnected default.
  const { data: integrationsData, loading: loadingIntegrations, error: integrationsError, refresh: refreshIntegrations } =
    useCachedJson<{ integrations?: Integration[] }>('/api/nango/integrations', { persist: true })
  const { data: statusData, loading: loadingStatus, error: statusError, refresh: refreshStatus, mutate: mutateStatus } =
    useCachedJson<{ connections?: Record<string, Connection> }>('/api/nango/status', { persist: true })
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'
  const integrations = useMemo(() => integrationsData?.integrations ?? [], [integrationsData])
  const connections = statusData?.connections ?? {}
  const loading = loadingIntegrations || loadingStatus
  const [busy, setBusy] = useState<string | null>(null)
  const [togglingLearningId, setTogglingLearningId] = useState<string | null>(null)
  const [rescanningId, setRescanningId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [recommendations, setRecommendations] = useState<IntegrationMatch[] | null>(null)
  const { isLearningEnabled, setLearningEnabled } = useScanExclusions()
  const connectUIRef = useRef<ConnectUI | null>(null)
  // The integration whose OAuth redirect just returned (?connected=<id>):
  // its tile shows "Confirming…" until a fresh status confirms it, instead of
  // flashing back to "Not connected".
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const toggleLearning = async (integration: Integration, enabled: boolean) => {
    if (!integration.capability) return
    setTogglingLearningId(integration.id)
    try {
      const ok = await setLearningEnabled(connectionSourceRef('nango', integration.capability), enabled)
      if (!ok) toast.error('Could not update learning setting.')
    } finally {
      setTogglingLearningId(null)
    }
  }

  const rescan = async (integration: Integration) => {
    if (!integration.capability) return
    setRescanningId(integration.id)
    try {
      const response = await fetch('/api/intelligence/rescan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plane: 'nango', connectionRef: integration.capability, connectionName: integration.name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not rescan this account.')
      toast.success('Connection scan complete.')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not rescan this account.') }
    finally { setRescanningId(null) }
  }

  const refreshLiveStatus = useCallback(async () => {
    const response = await fetch('/api/nango/status?refresh=1', { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Could not refresh connection status.')
    mutateStatus(data)
    return data as { connections?: Record<string, Connection> }
  }, [mutateStatus])

  const refreshAll = useCallback(() => {
    void refreshIntegrations()
    void refreshLiveStatus().catch((error) => toast.error(error instanceof Error ? error.message : 'Could not refresh connection status.'))
  }, [refreshIntegrations, refreshLiveStatus])

  useEffect(() => {
    return () => {
      connectUIRef.current?.close()
      connectUIRef.current = null
    }
  }, [])

  const recommendedIds = recommendations ? new Set(recommendations.map((match) => match.id)) : null
  const visibleIntegrations = recommendedIds
    ? integrations.filter((integration) => recommendedIds.has(integration.id))
    : query.trim()
      ? integrations.filter((integration) => `${integration.name} ${integration.provider}`.toLowerCase().includes(query.trim().toLowerCase()))
      : integrations
  const { pageItems, pageCount, page: currentPage } = paginate(visibleIntegrations, page, INTEGRATIONS_PAGE_SIZE)

  // Nango's connection listing is eventually consistent: right after the
  // Connect UI reports success, /api/nango/status often does not include the
  // new connection yet. Poll with backoff until the badge can actually flip
  // instead of leaving the user to hammer the manual refresh button.
  const confirmConnected = useCallback(async (integrationId: string) => {
    for (const delayMs of [0, 1000, 2000, 4000, 8000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const status = await refreshLiveStatus().catch(() => refreshStatus())
      if (status?.connections?.[integrationId]?.connected) return
    }
  }, [refreshLiveStatus, refreshStatus])

  // Native OAuth returns via a full-page redirect with ?connected=<id>. The
  // page component swaps the param out of the URL right after mount, so
  // capture it here (child effects run first) and poll status until the new
  // connection is confirmed.
  useEffect(() => {
    const connectedId = new URLSearchParams(window.location.search).get('connected')
    if (!connectedId) return
    setConfirmingId(connectedId)
    void confirmConnected(connectedId).finally(() => setConfirmingId(null))
  }, [confirmConnected])

  const connect = async (integration: Integration) => {
    // Configured on its own page (several named connections behind one tile).
    if (integration.configPath) {
      router.push(integration.configPath)
      return
    }
    // Native Google OAuth: full-page redirect to our own consent flow —
    // Google blocks Nango's, and a popup would lose the session on return.
    if (integration.native) {
      setBusy(integration.id)
      window.location.href = `/api/google/oauth/start?service=${encodeURIComponent(integration.id)}`
      return
    }
    setBusy(integration.id)
    try {
      const nango = new Nango()
      const connectBaseUrl = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
      const connectUI = nango.openConnectUI({
        ...(connectBaseUrl ? { baseURL: connectBaseUrl } : {}),
        onEvent: (event) => {
          if (event.type === 'connect') {
            toast.success(`${integration.name} connected`)
            connectUIRef.current = null
            setBusy(null)
            void confirmConnected(integration.id)
          } else if (event.type === 'close') {
            connectUIRef.current = null
            setBusy(null)
          } else if (event.type === 'error') {
            toast.error(event.payload.errorMessage || 'Unable to connect account')
          }
        },
      })
      connectUIRef.current = connectUI

      const response = await fetch('/api/nango/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: integration.id }),
      })
      const data = await response.json()
      if (!response.ok || !data.sessionToken) {
        connectUI.close()
        connectUIRef.current = null
        throw new Error(data.error || 'Unable to start the connection flow')
      }
      connectUI.setSessionToken(data.sessionToken)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to connect account')
      setBusy(null)
    }
  }

  const disconnect = async (integration: Integration) => {
    if (!window.confirm(`Disconnect ${integration.name}?`)) return
    setBusy(integration.id)
    try {
      const entry = connections[integration.id]
      if (entry?.native && entry.connectionIds.length) {
        // Native Google connections disconnect one record at a time.
        for (const connectionId of entry.connectionIds) {
          const response = await fetch(`/api/google/oauth/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' })
          if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Unable to disconnect account')
          }
        }
        await refreshLiveStatus()
        return
      }
      const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to disconnect account')
      await refreshLiveStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to disconnect account')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" size="icon" onClick={refreshAll} disabled={loading} aria-label="Refresh connected accounts" title="Refresh connected accounts">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {Boolean(integrationsError || statusError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><p>Connected accounts could not be loaded. Existing connections may still be active.</p><Button className="mt-2" variant="outline" size="sm" onClick={refreshAll}>Try again</Button></div>
      )}

      <IntegrationAiSearch
        items={integrations.map((integration) => ({ id: integration.id, name: integration.name, description: `Connect ${integration.name} so agents can act on the user's behalf.` }))}
        query={query}
        onQueryChange={(value) => { setQuery(value); setPage(1) }}
        onRecommendations={(matches) => { setRecommendations(matches); setPage(1) }}
      />

      {!integrationsError && !statusError && !loading && !visibleIntegrations.length && busy !== 'loading' && (
        <EmptyState
          title="No integrations are enabled yet"
          description="Enable integrations in your Nango dashboard and they appear here."
        />
      )}

      <div className="stagger-children grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((integration) => {
          const connection = connections[integration.id]
          return (
            <Card key={integration.id} variant="interactive">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3 text-base">
                  <span className="flex items-center gap-2">
                    <IntegrationLogo src={integration.logo} slug={integration.provider} name={integration.name} />
                    {integration.name}
                  </span>
                  {(() => {
                    if (connection?.connected) return <Badge variant="good"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>
                    // Just returned from this integration's OAuth consent —
                    // don't flash "Not connected" while status catches up.
                    if (confirmingId === integration.id) return <Badge variant="secondary"><RefreshCw className="mr-1 h-3 w-3 animate-spin" />Confirming…</Badge>
                    // No status data yet (first visit, cold cache): unknown, not disconnected.
                    if (!statusData && loadingStatus) return <Badge variant="secondary">Checking…</Badge>
                    return <Badge variant="secondary">Not connected</Badge>
                  })()}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
                  {integration.configPath
                    ? `Connect one or more ${integration.name} databases so agents, flows, and goals can read from them.`
                    : `Connect your ${integration.name} account so agents can act on your behalf.`}
                </p>
                {connection?.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {/* A configPath tile manages N connections, so its action is
                    always "open the page" — never a binary disconnect. */}
                {integration.configPath ? (
                  <Button className="w-full" variant={connection?.connected ? 'outline' : 'default'} onClick={() => connect(integration)}>
                    {connection?.connected
                      ? `Manage${connection.connectionIds.length > 1 ? ` (${connection.connectionIds.length})` : ''}`
                      : 'Connect'}
                  </Button>
                ) : connection?.connected
                  ? <Button className="w-full" variant="outline" onClick={() => disconnect(integration)} loading={busy === integration.id}>Disconnect</Button>
                  : <Button className="w-full" onClick={() => connect(integration)} loading={busy === integration.id || confirmingId === integration.id}>
                      Connect
                    </Button>}
                {connection?.connected && integration.capability && (
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <Button size="sm" variant="ghost" loading={rescanningId === integration.id} disabled={rescanningId !== null} onClick={() => void rescan(integration)}>Rescan</Button>
                    <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">Learning</span><Switch checked={isLearningEnabled(connectionSourceRef('nango', integration.capability))} disabled={togglingLearningId === integration.id || !isAdmin} onCheckedChange={(enabled) => toggleLearning(integration, enabled)} aria-label={isLearningEnabled(connectionSourceRef('nango', integration.capability)) ? 'Disable learning from this connection' : 'Enable learning from this connection'} /></div>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
      <Pagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
    </div>
  )
}
