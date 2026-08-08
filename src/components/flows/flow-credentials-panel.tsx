'use client'

/**
 * Flows page credentials tab — every credential/connection the caller's flows
 * depend on, grouped by kind, with fix-it-here actions.
 *
 * The inventory itself lives on the Integrations page; this panel is the
 * flow-centric lens over it (which flows depend on this, is it healthy) so a
 * broken credential can be reconnected or removed without hunting through
 * step configs. Data comes from /api/flows/credentials; every action reuses
 * the endpoints the Integrations panels already call — nothing here has its
 * own mutation semantics.
 */
import { useMemo, useRef, useState } from 'react'
import Nango, { type ConnectUI } from '@nangohq/frontend'
import { toast } from 'sonner'
import { Cable, ExternalLink, KeyRound, RefreshCw, Server, ShieldQuestion, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ScopedLink } from '@/components/ui/scoped-link'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { VerificationBadge, type VerificationView } from '@/components/flows/nodes/verification-badge'

type FlowRef = { id: string; name: string }

/** Mirror of the /api/flows/credentials item shape (see that route). */
type FlowCredentialItem = {
  key: string
  kind: 'mcp' | 'credential' | 'account'
  name: string
  detail?: string
  plane?: 'nango' | 'native' | 'postgres'
  provider?: string
  id: string
  integrationId?: string
  configPath?: string
  missing?: boolean
  inactive?: boolean
  connected?: boolean
  verification: VerificationView
  flows: FlowRef[]
}

type Response = { success?: boolean; items?: FlowCredentialItem[] }

const SECTIONS = [
  { kind: 'mcp' as const, title: 'MCP Servers', icon: Server, blurb: 'Servers your flow tool steps call.' },
  { kind: 'credential' as const, title: 'API Credentials', icon: KeyRound, blurb: 'Vault credentials HTTP steps authenticate with.' },
  { kind: 'account' as const, title: 'Integration Accounts', icon: Cable, blurb: 'Connected accounts delivery steps send through.' },
]

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function FlowCredentialsPanel() {
  const scope = useScope()
  const router = useScopedRouter()
  const { data, loading, error, refresh } = useCachedJson<Response>(`/api/flows/credentials?goal=${encodeURIComponent(scope)}`)
  const items = useMemo(() => data?.items ?? [], [data])
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<FlowCredentialItem | null>(null)
  const connectUIRef = useRef<ConnectUI | null>(null)

  /** The credentials list is derived state — re-pull it a few times after a
   *  reconnect since Nango's listing is eventually consistent. */
  const refreshSoon = () => {
    void refresh()
    for (const delayMs of [1500, 4000, 9000]) setTimeout(() => void refresh(), delayMs)
  }

  const checkNow = async (item: FlowCredentialItem) => {
    setBusyKey(item.key)
    try {
      const response =
        item.kind === 'credential'
          ? await fetch(`/api/credentials/${encodeURIComponent(item.id)}/verify`, { method: 'POST' })
          : await fetch('/api/connections/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ connectionId: item.key }),
            })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The check could not run.')
      toast[body.verification?.state === 'verified' ? 'success' : 'warning'](
        body.verification?.state === 'verified' ? `"${item.name}" is working.` : `"${item.name}" is still not working.`,
      )
      void refresh()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The check could not run.')
    } finally {
      setBusyKey(null)
    }
  }

  const reconnectNango = async (item: FlowCredentialItem) => {
    if (!item.integrationId) return
    setBusyKey(item.key)
    try {
      const nango = new Nango()
      const connectBaseUrl = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
      const connectUI = nango.openConnectUI({
        ...(connectBaseUrl ? { baseURL: connectBaseUrl } : {}),
        onEvent: (event) => {
          if (event.type === 'connect') {
            toast.success(`${item.name} connected`)
            connectUIRef.current = null
            setBusyKey(null)
            refreshSoon()
          } else if (event.type === 'close') {
            connectUIRef.current = null
            setBusyKey(null)
          } else if (event.type === 'error') {
            toast.error(event.payload.errorMessage || 'Unable to connect account')
          }
        },
      })
      connectUIRef.current = connectUI
      const response = await fetch('/api/nango/session-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrationId: item.integrationId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.sessionToken) {
        connectUI.close()
        connectUIRef.current = null
        throw new Error(body.error || 'Unable to start the connection flow')
      }
      connectUI.setSessionToken(body.sessionToken)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Unable to connect account')
      setBusyKey(null)
    }
  }

  const reconnect = (item: FlowCredentialItem) => {
    if (item.kind === 'mcp' && item.provider) {
      // OAuth reauthorize round-trips through the provider and back here.
      const returnTo = `${window.location.pathname}?tab=credentials`
      window.location.href = `/api/mcp-connections/oauth/start?connectionId=${encodeURIComponent(item.id)}&returnTo=${encodeURIComponent(returnTo)}`
      return
    }
    if (item.plane === 'nango') {
      void reconnectNango(item)
      return
    }
    if (item.configPath) router.push(item.configPath)
  }

  const remove = async (item: FlowCredentialItem) => {
    setRemoveTarget(null)
    setBusyKey(item.key)
    try {
      let response: globalThis.Response
      if (item.kind === 'mcp') {
        response = await fetch('/api/mcp-connections', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        })
      } else if (item.kind === 'credential') {
        response = await fetch(`/api/credentials/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      } else if (item.plane === 'nango' && item.integrationId) {
        response = await fetch(`/api/nango/connections/${encodeURIComponent(item.integrationId)}`, { method: 'DELETE' })
      } else if (item.plane === 'postgres') {
        response = await fetch(`/api/postgres/connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      } else {
        return
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || 'Could not remove it.')
      }
      toast.success(`"${item.name}" removed.`)
      void refresh()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not remove it.')
    } finally {
      setBusyKey(null)
    }
  }

  const reconnectLabel = (item: FlowCredentialItem): string | null => {
    if (item.kind === 'mcp') return item.provider ? 'Reauthorize' : null
    if (item.kind === 'credential') return item.missing ? null : 'Edit'
    if (item.plane === 'nango') return item.connected ? 'Reconnect' : 'Connect'
    return 'Manage'
  }

  const removable = (item: FlowCredentialItem): boolean => {
    if (item.missing) return false
    if (item.kind === 'account') return item.plane === 'nango' ? Boolean(item.connected && item.integrationId) : item.plane === 'postgres'
    return true
  }

  if (loading && items.length === 0) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={`credential-skeleton-${i}`} className="h-24 rounded-xl" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
        <p className="font-medium">Flow credentials could not be loaded.</p>
        <Button className="mt-3" variant="outline" onClick={() => void refresh()}>Try again</Button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={ShieldQuestion}
        title="No credentials in use"
        description="None of your flows reference an MCP server, API credential, or connected account yet. Credentials appear here automatically once a step uses one."
        action={
          <Button variant="outline" onClick={() => router.push('/integrations')}>
            <Cable className="mr-1.5 h-4 w-4" /> Open Integrations
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {SECTIONS.map(({ kind, title, icon: Icon, blurb }) => {
        const rows = items.filter((item) => item.kind === kind)
        if (rows.length === 0) return null
        return (
          <section key={kind} className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">{title}</h2>
              <span className="text-xs text-muted-foreground">— {blurb}</span>
            </div>
            <div className="divide-y rounded-xl border bg-card">
              {rows.map((item) => {
                const label = reconnectLabel(item)
                return (
                  <div key={item.key} className="flex flex-wrap items-start gap-3 p-4">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{item.name}</p>
                        {item.detail && <span className="text-xs text-muted-foreground">{item.detail}</span>}
                        {item.missing && <Badge variant="outline" className="border-red-200 bg-red-50 text-[10px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">Missing</Badge>}
                        {item.inactive && <Badge variant="outline" className="text-[10px] text-muted-foreground">Inactive</Badge>}
                      </div>
                      <VerificationBadge verification={item.verification} />
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] text-muted-foreground">Used by</span>
                        {item.flows.map((flow) => (
                          <ScopedLink key={flow.id} href={`/flows/${flow.id}`} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-foreground/30 hover:text-foreground">
                            {flow.name}
                          </ScopedLink>
                        ))}
                      </div>
                      {item.missing && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          The flows above reference this, but it no longer exists or belongs to another member — their steps will fail until it is replaced in the step config.
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!item.missing && (
                        <Button size="sm" variant="ghost" disabled={busyKey === item.key} onClick={() => void checkNow(item)} title="Run the connection check now">
                          <RefreshCw className={busyKey === item.key ? 'mr-1 h-3.5 w-3.5 animate-spin' : 'mr-1 h-3.5 w-3.5'} /> Check
                        </Button>
                      )}
                      {label && (
                        <Button size="sm" variant="outline" disabled={busyKey === item.key} onClick={() => reconnect(item)}>
                          {label === 'Manage' || label === 'Edit' ? <ExternalLink className="mr-1 h-3.5 w-3.5" /> : <Cable className="mr-1 h-3.5 w-3.5" />}
                          {label}
                        </Button>
                      )}
                      {removable(item) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-600"
                          disabled={busyKey === item.key}
                          onClick={() => setRemoveTarget(item)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" /> {item.plane === 'nango' ? 'Disconnect' : 'Delete'}
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      <Dialog open={Boolean(removeTarget)} onOpenChange={(next) => { if (!next) setRemoveTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {removeTarget?.plane === 'nango' ? `Disconnect “${removeTarget?.name}”?` : `Delete “${removeTarget?.name}”?`}
            </DialogTitle>
            <DialogDescription>
              It is used by {plural(removeTarget?.flows.length ?? 0, 'flow')} — steps that depend on it will fail until you
              connect a replacement and update those steps.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (removeTarget) void remove(removeTarget) }}>
              {removeTarget?.plane === 'nango' ? 'Disconnect' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
