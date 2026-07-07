'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { CheckCircle2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'

type Integration = {
  id: string
  provider: string
  name: string
  logo?: string
}

type Connection = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
}

export function OAuthIntegrationsGrid() {
  // Cached (stale-while-revalidate): the integration catalog is static (also
  // server-cached), connections revalidate in the background. A revisit paints
  // the last-seen grid instantly instead of the loading skeleton.
  const { data: integrationsData, loading: loadingIntegrations, refresh: refreshIntegrations } =
    useCachedJson<{ integrations?: Integration[] }>('/api/nango/integrations')
  const { data: statusData, loading: loadingStatus, refresh: refreshStatus } =
    useCachedJson<{ connections?: Record<string, Connection> }>('/api/nango/status')
  const integrations = useMemo(() => integrationsData?.integrations ?? [], [integrationsData])
  const connections = statusData?.connections ?? {}
  const loading = loadingIntegrations || loadingStatus
  const [busy, setBusy] = useState<string | null>(null)
  const connectUIRef = useRef<ConnectUI | null>(null)

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

  const visibleIntegrations = integrations

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

      {!visibleIntegrations.length && busy !== 'loading' && (
        <EmptyState
          title="No integrations are enabled yet"
          description="Enable integrations in your Nango dashboard and they appear here."
        />
      )}

      <div className="stagger-children grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleIntegrations.map((integration) => {
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
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
