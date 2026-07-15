'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
}

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
}

const INTEGRATIONS_PAGE_SIZE = 9

export function OAuthIntegrationsGrid() {
  // Cached (stale-while-revalidate): the integration catalog is static (also
  // server-cached), connections revalidate in the background. A revisit paints
  // the last-seen grid instantly instead of the loading skeleton.
  const { data: integrationsData, loading: loadingIntegrations, refresh: refreshIntegrations } =
    useCachedJson<{ integrations?: Integration[] }>('/api/nango/integrations')
  const { data: statusData, loading: loadingStatus, refresh: refreshStatus } =
    useCachedJson<{ connections?: Record<string, Connection> }>('/api/nango/status')
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'
  const integrations = useMemo(() => integrationsData?.integrations ?? [], [integrationsData])
  const connections = statusData?.connections ?? {}
  const loading = loadingIntegrations || loadingStatus
  const [busy, setBusy] = useState<string | null>(null)
  const [togglingLearningId, setTogglingLearningId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [recommendations, setRecommendations] = useState<IntegrationMatch[] | null>(null)
  const { isLearningEnabled, setLearningEnabled } = useScanExclusions()
  const connectUIRef = useRef<ConnectUI | null>(null)

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

  const refreshAll = useCallback(() => {
    void refreshIntegrations()
    void refreshStatus()
  }, [refreshIntegrations, refreshStatus])

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

  const connect = async (integration: Integration) => {
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
            void refreshStatus()
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
      const response = await fetch(`/api/nango/connections/${encodeURIComponent(integration.id)}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to disconnect account')
      await refreshStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to disconnect account')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" size="icon" onClick={refreshAll} disabled={loading}>
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <IntegrationAiSearch
        items={integrations.map((integration) => ({ id: integration.id, name: integration.name, description: `Connect ${integration.name} so agents can act on the user's behalf.` }))}
        query={query}
        onQueryChange={(value) => { setQuery(value); setPage(1) }}
        onRecommendations={(matches) => { setRecommendations(matches); setPage(1) }}
      />

      {!visibleIntegrations.length && busy !== 'loading' && (
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
                  {connection?.connected ? (
                    <Badge variant="good"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>
                  ) : (
                    <Badge variant="secondary">Not connected</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="line-clamp-2 min-h-10 text-sm text-gray-500">
                  Connect your {integration.name} account so agents can act on your behalf.
                </p>
                {connection?.error && <p className="text-sm text-red-600">{connection.error}</p>}
                {connection?.connected
                  ? <Button className="w-full" variant="outline" onClick={() => disconnect(integration)} loading={busy === integration.id}>Disconnect</Button>
                  : <Button className="w-full" onClick={() => connect(integration)} loading={busy === integration.id}>
                      Connect
                    </Button>}
                {connection?.connected && integration.capability && (
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <span className="text-xs text-muted-foreground">Learning</span>
                    <Switch
                      checked={isLearningEnabled(connectionSourceRef('nango', integration.capability))}
                      disabled={togglingLearningId === integration.id || !isAdmin}
                      onCheckedChange={(enabled) => toggleLearning(integration, enabled)}
                      aria-label={
                        isLearningEnabled(connectionSourceRef('nango', integration.capability))
                          ? 'Disable learning from this connection'
                          : 'Enable learning from this connection'
                      }
                    />
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
