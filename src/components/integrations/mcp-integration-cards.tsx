'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Pagination, paginate } from '@/components/ui/pagination'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useCachedJson } from '@/lib/client/use-cached-json'

type Tool = { name: string; description?: string }

type Connection = {
  provider: string
  status: 'pending_auth' | 'active' | 'error' | 'not_connected'
  oauthUrl?: string
  toolCount?: number
  capabilities?: { description?: string; verbs?: string[] }
  tools?: Tool[]
}

type StrataServer = { name: string; label: string; description?: string; toolCount?: number }
type StrataCatalog = { strata: boolean; connectionName?: string; servers?: StrataServer[]; error?: string }

const STRATA_PAGE_SIZE = 15

function toolLabel(name: string) {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** "google calendar" → "googlecalendar", "cal.com" → "calcom" — the logo slug. */
function strataSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Strata catalogue: every tool behind the org's Klavis Strata connection.
 * They're team-authorized at the Klavis account level and load for every
 * agent via Strata's discovery meta-tools, so each one reports connected.
 */
function StrataCatalogue({ servers, connectionName }: { servers: StrataServer[]; connectionName?: string }) {
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? servers.filter((s) => `${s.label} ${s.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : servers
  const { pageItems, pageCount, page: current } = paginate(filtered, page, STRATA_PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {servers.length} tools available to every agent via{' '}
          <span className="font-medium text-foreground">{connectionName || 'Klavis Strata'}</span>.
        </p>
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
          placeholder="Search tools"
          className="h-9 w-56"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No tools match “{query.trim()}”.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {pageItems.map((server) => (
            <Card key={server.name}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  <span className="flex min-w-0 items-center gap-2">
                    <IntegrationLogo slug={strataSlug(server.name)} name={server.label} />
                    <span className="truncate">{server.label}</span>
                  </span>
                  <Badge variant="good" className="shrink-0"><CheckCircle2 className="mr-1 h-3 w-3" />Connected</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="line-clamp-2 min-h-10 text-gray-500">
                  {server.description || `Use ${server.label} from your agents.`}
                </p>
                {typeof server.toolCount === 'number' && server.toolCount > 0 && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Wrench className="h-3.5 w-3.5" /> {server.toolCount} {server.toolCount === 1 ? 'action' : 'actions'}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
    </div>
  )
}

export function MCPIntegrationCards() {
  // The Strata catalogue is the primary source (one team-authorized endpoint,
  // every tool). The legacy per-provider cards render only when the org has no
  // Strata connection, so a fresh workspace still has a working connect path.
  const { data: strataData, loading: strataLoading } = useCachedJson<StrataCatalog>('/api/mcp/strata-catalog')
  // Cached (stale-while-revalidate): a revisit paints instantly from the client
  // cache, then revalidates — no flash. The server also caches the Klavis status
  // per org, so the revalidation itself is fast.
  const { data, loading, error: loadError, refresh } = useCachedJson<{ connections?: Connection[] }>('/api/mcp/connections')
  const connections = data?.connections ?? []
  const [connecting, setConnecting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

  const connect = async (provider: string) => {
    setConnecting(provider)
    setActionError('')
    try {
      const response = await fetch('/api/mcp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [provider] }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Connection failed')
      const res = result.results?.[0]
      if (res?.oauthUrl) {
        const popup = window.open(res.oauthUrl, '_blank', 'width=600,height=700')
        if (!popup) setActionError('Your browser blocked the sign-in popup — allow popups for this site and click Connect again.')
      } else if (res?.status !== 'active') {
        const name = provider.charAt(0).toUpperCase() + provider.slice(1)
        setActionError(`${name} authenticates in your Klavis dashboard, not via a popup. Once it shows Authorized there, it appears connected here.`)
      }
      await refresh() // server cache is busted on connect; pull the fresh status
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Connection failed')
    } finally {
      setConnecting(null)
    }
  }

  // Strata present: the catalogue replaces the per-provider cards entirely.
  if (strataData?.strata && (strataData.servers?.length ?? 0) > 0) {
    return <StrataCatalogue servers={strataData.servers!} connectionName={strataData.connectionName} />
  }
  if (strataLoading && !connections.length) {
    return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading tools...</div>
  }

  const error = actionError || (loadError ? (loadError instanceof Error ? loadError.message : 'Failed to load Klavis connections') : '')

  // Only block on the spinner when there's no cached data to show yet.
  if (loading && !connections.length) return <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading Klavis connections...</div>

  return (
    <div className="space-y-4">
      {error && <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="h-4 w-4" /> {error}</div>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connections.map((connection) => {
          const isOpen = expanded === connection.provider
          const tools = connection.tools ?? []
          const isActive = connection.status === 'active'
          return (
            <Card key={connection.provider}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base capitalize">
                  <span className="flex items-center gap-2">
                    <IntegrationLogo slug={connection.provider} name={connection.provider} />
                    {connection.provider}
                  </span>
                  <Badge variant="outline">{connection.status.replace('_', ' ')}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-gray-500">{connection.capabilities?.description || 'Klavis MCP connection'}</p>

                {tools.length > 0 && (
                  <div className="rounded-lg border">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : connection.provider)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-gray-600 hover:bg-gray-50"
                    >
                      <span className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5" /> {tools.length} {tools.length === 1 ? 'tool' : 'tools'}{isActive ? '' : ' available'}</span>
                      <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                    {isOpen && (
                      <ul className="space-y-2 border-t px-3 py-2">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <p className="font-medium text-gray-800">{toolLabel(tool.name)}</p>
                            {tool.description && <p className="text-xs text-gray-500">{tool.description}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {!isActive && (
                  <Button className="w-full" disabled={connecting === connection.provider} onClick={() => connect(connection.provider)}>
                    {connecting === connection.provider ? 'Connecting...' : 'Connect with Klavis'}
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
      {!connections.length && <p className="text-sm text-gray-500">No Klavis providers are configured.</p>}
    </div>
  )
}
