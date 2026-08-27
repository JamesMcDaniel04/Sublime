'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, Loader2, RefreshCw, Store } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { useScopedHref } from '@/lib/client/scoped-href'
import { cn } from '@/lib/utils'

type Listing = {
  id: string
  slug: string
  name: string
  description: string
  category: string
  kind: 'native' | 'external'
  visibility: 'organization' | 'public'
  version: number
  publisher: { id: string; name: string }
  mine: boolean
  requiresSecret: boolean
  integrations: string[]
  endpointHost: string | null
  install: { agentTaskId: string; installedVersion: number; updateAvailable: boolean } | null
}

/**
 * The store: agent packages other workspaces published. Install puts one on
 * this roster as a teammate; an update is offered by version and never
 * silently overwrites local edits — the second click is the consent.
 */
export function StoreSection() {
  const { data, refresh } = useCachedJson<{ listings?: Listing[] }>('/api/store')
  const href = useScopedHref()
  const [busy, setBusy] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [confirmForce, setConfirmForce] = useState<string | null>(null)
  const listings = data?.listings ?? []
  if (listings.length === 0) return null

  const install = async (listing: Listing, opts: { update?: boolean; force?: boolean } = {}) => {
    if (busy) return
    if (listing.requiresSecret && !listing.install && !secrets[listing.id]?.trim()) {
      toast.error('This agent authenticates to its endpoint — add your credential first.')
      return
    }
    setBusy(listing.id)
    try {
      const response = await fetch(`/api/store/${listing.id}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(secrets[listing.id]?.trim() ? { secret: secrets[listing.id].trim() } : {}), ...opts }),
      })
      const payload = await response.json().catch(() => ({}))
      if (response.status === 409 && payload.code === 'LOCAL_EDITS') {
        setConfirmForce(listing.id)
        return
      }
      if (!response.ok) {
        toast.error(payload.error || 'Could not install that agent.')
        return
      }
      setConfirmForce(null)
      setSecrets((s) => ({ ...s, [listing.id]: '' }))
      toast.success(opts.update ? `Updated to v${payload.installedVersion}` : `${listing.name} joined your team`)
      refresh()
    } catch {
      toast.error('Could not install that agent.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="store-heading">
      <div>
        <h3 id="store-heading" className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
          <Store className="h-4 w-4" aria-hidden /> Store
        </h3>
        <p className="text-xs text-muted-foreground">Agents other workspaces published. Installing one puts it on your team.</p>
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {listings.map((listing) => {
          const isBusy = busy === listing.id
          const installed = listing.install
          return (
            <div key={listing.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{listing.name}</div>
                  <div className="text-xs text-muted-foreground">
                    by {listing.publisher.name}{listing.mine ? ' (you)' : ''} · v{listing.version}
                  </div>
                </div>
                <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', listing.kind === 'external' ? 'border-border/60 text-muted-foreground' : 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200')}>
                  {listing.kind === 'external' ? `External · ${listing.endpointHost ?? 'service'}` : 'Runs in Sublime'}
                </span>
              </div>
              {listing.description && <p className="line-clamp-3 text-sm text-muted-foreground">{listing.description}</p>}
              {listing.integrations.length > 0 && (
                <p className="text-xs text-muted-foreground">Uses {listing.integrations.join(', ')}</p>
              )}
              {listing.requiresSecret && !installed && (
                <label className="block text-xs text-muted-foreground">
                  Your credential for {listing.endpointHost ?? 'the endpoint'}
                  <input
                    type="password"
                    autoComplete="off"
                    value={secrets[listing.id] ?? ''}
                    onChange={(event) => setSecrets((s) => ({ ...s, [listing.id]: event.target.value }))}
                    className="mt-0.5 w-full rounded-md border bg-background px-2 py-1 text-sm text-foreground"
                  />
                </label>
              )}
              <div className="mt-auto flex flex-wrap items-center gap-2">
                {!installed ? (
                  <Button size="sm" disabled={isBusy} onClick={() => void install(listing)}>
                    {isBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                    Install
                  </Button>
                ) : (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link href={href(`/agents/${installed.agentTaskId}`)}><ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Installed · open</Link>
                    </Button>
                    {installed.updateAvailable && (
                      confirmForce === listing.id ? (
                        <Button size="sm" variant="destructive" disabled={isBusy} onClick={() => void install(listing, { update: true, force: true })}>
                          Overwrite local edits with v{listing.version}
                        </Button>
                      ) : (
                        <Button size="sm" disabled={isBusy} onClick={() => void install(listing, { update: true })}>
                          {isBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                          Update to v{listing.version}
                        </Button>
                      )
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
