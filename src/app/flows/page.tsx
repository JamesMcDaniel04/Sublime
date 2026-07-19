'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Copy, MoreHorizontal, Plus, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { getCachedJson, invalidateCachedJson } from '@/lib/client/use-cached-json'
import { STARTER_TEMPLATES, type StarterTemplate } from '@/lib/flows/starter-templates'

/** Cards per page on the Flows grid. */
const PAGE_SIZE = 9

type FlowItem = {
  id: string
  name: string
  description: string
  status: string
  stepCount: number
  updatedAt: string
  /** Full definition (in the list payload) — lets Duplicate copy the flow verbatim. */
  trigger?: unknown
  graph?: unknown
  suggested?: boolean
  unpublishedChanges?: boolean
  sharedWithYou?: boolean
}

type SuggestionReadiness = { ready: boolean; totalConnections: number; connectionsNeeded: number }

const STATUS_STYLE: Record<string, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  draft: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  disabled: 'border-border bg-muted text-muted-foreground',
}

export default function FlowsPage() {
  const router = useRouter()
  const [flows, setFlows] = useState<FlowItem[]>([])
  const [readiness, setReadiness] = useState<SuggestionReadiness | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FlowItem | null>(null)
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    getCachedJson<any>('/api/flows')
      .then((data) => {
        if (cancelled) return
        if (!data.success) throw new Error(data.error || 'Could not load flows.')
        setFlows(data.flows ?? [])
        setReadiness(data.suggestionReadiness ?? null)
      })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load flows.') })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadAttempt])

  const suggestedFlows = useMemo(() => flows.filter((flow) => flow.suggested && flow.status === 'draft'), [flows])
  const otherFlows = useMemo(() => flows.filter((flow) => !(flow.suggested && flow.status === 'draft')), [flows])

  const dismissSuggestion = async (id: string) => {
    setDismissingId(id)
    const previous = flows
    setFlows((prev) => prev.filter((flow) => flow.id !== id))
    try {
      const response = await fetch(`/api/flows/${id}/dismiss-suggestion`, { method: 'POST' })
      if (!response.ok) {
        setFlows(previous)
        toast.error('Could not dismiss that suggestion.')
      } else {
        invalidateCachedJson('/api/flows')
      }
    } catch {
      setFlows(previous)
      toast.error('Could not dismiss that suggestion.')
    } finally {
      setDismissingId(null)
    }
  }

  const createFlow = async () => {
    setCreating(true)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Untitled flow' }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.flow) {
        invalidateCachedJson('/api/flows')
        router.push(`/flows/${data.flow.id}`)
      }
      else toast.error(data.error || 'Could not create the flow.')
    } catch {
      toast.error('Could not create the flow.')
    } finally {
      setCreating(false)
    }
  }

  /** Instantiate a starter template as the user's own draft flow and open it. */
  const createFromTemplate = async (template: StarterTemplate) => {
    setUsingTemplate(template.key)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          trigger: template.trigger,
          graph: template.graph,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.flow) {
        invalidateCachedJson('/api/flows')
        router.push(`/flows/${data.flow.id}`)
      } else {
        toast.error(data.error || 'Could not create the flow from this template.')
      }
    } catch {
      toast.error('Could not create the flow from this template.')
    } finally {
      setUsingTemplate(null)
    }
  }

  const duplicateFlow = async (flow: FlowItem) => {
    setDuplicatingId(flow.id)
    try {
      const response = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${flow.name} (copy)`,
          description: flow.description || '',
          trigger: flow.trigger,
          graph: flow.graph,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.flow) {
        invalidateCachedJson('/api/flows')
        router.push(`/flows/${data.flow.id}`)
      } else {
        toast.error(data.error || 'Could not duplicate the flow.')
      }
    } catch {
      toast.error('Could not duplicate the flow.')
    } finally {
      setDuplicatingId(null)
    }
  }

  /** Optimistic delete: remove the card immediately, restore + toast on failure. */
  const deleteFlow = async (flow: FlowItem) => {
    const previous = flows
    setFlows((prev) => prev.filter((entry) => entry.id !== flow.id))
    setDeleteTarget(null)
    try {
      const response = await fetch('/api/flows', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: flow.id }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error)
      }
      invalidateCachedJson('/api/flows')
    } catch (cause) {
      setFlows(previous)
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not delete the flow.')
    }
  }

  const { pageItems, pageCount, page: current } = paginate(otherFlows, page, PAGE_SIZE)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Pipelines" title="Flows" description="Wire your agents into deterministic multi-step pipelines." />
        <Button onClick={createFlow} loading={creating}>
          <Plus className="mr-1.5 h-4 w-4" /> New flow
        </Button>
      </div>

      {!loading && suggestedFlows.length > 0 && (
        <div className="space-y-3 rounded-xl border bg-muted/40 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-foreground" />
            <p className="text-sm font-semibold text-foreground">Your AI is ready — suggested for you</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {suggestedFlows.map((flow) => (
              <div key={flow.id} className="rounded-lg border bg-background p-3">
                <p className="truncate text-sm font-semibold" title={flow.name}>{flow.name}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{flow.description || 'A workflow draft based on how your team uses its connected tools.'}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" onClick={() => router.push(`/flows/${flow.id}`)}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={dismissingId === flow.id}
                    onClick={() => dismissSuggestion(flow.id)}
                  >
                    <X className="mr-1 h-3.5 w-3.5" /> Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && readiness && !readiness.ready && (
        <div className="rounded-xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          Connect {readiness.connectionsNeeded} more tool{readiness.connectionsNeeded === 1 ? '' : 's'} and Sublime starts building for you.
        </div>
      )}

      {!loading && !loadError && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold">Start from a template</p>
            <p className="text-xs text-muted-foreground">
              Ready-to-run flows — pick one, connect the tools it lists, and run it as-is.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STARTER_TEMPLATES.map((template) => (
              <div key={template.key} className="flex flex-col rounded-lg border bg-card p-3 transition-colors hover:border-foreground/30">
                <p className="text-sm font-semibold">{template.name}</p>
                <p className="mt-0.5 line-clamp-2 flex-1 text-xs text-muted-foreground">{template.description}</p>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap gap-1">
                    {template.requires.map((integration) => (
                      <Badge key={integration} variant="outline" className="text-[10px] font-medium text-muted-foreground">
                        {integration}
                      </Badge>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    loading={usingTemplate === template.key}
                    disabled={usingTemplate !== null}
                    onClick={() => createFromTemplate(template)}
                  >
                    Use template
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`flow-skeleton-${i}`} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><p className="font-medium">Your flows could not be loaded.</p><p className="mt-1">{loadError}</p><Button className="mt-3" variant="outline" onClick={() => { invalidateCachedJson('/api/flows'); setLoadAttempt((value) => value + 1) }}>Try again</Button></div>
      ) : otherFlows.length === 0 ? (
        suggestedFlows.length === 0 ? (
          <EmptyState
            icon={Workflow}
            title="No flows yet"
            description="Build your first agent pipeline — chain agents, branch on results, and fan out over accounts."
            action={
              <Button onClick={createFlow} loading={creating}>
                <Plus className="mr-1.5 h-4 w-4" /> New flow
              </Button>
            }
          />
        ) : null
      ) : (
        <>
          <div className="stagger-children grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((flow) => (
              <Link key={flow.id} href={`/flows/${flow.id}`} className="block">
                <Card className="group relative h-full overflow-hidden transition-colors duration-200 hover:border-foreground/30">
                  <CardHeader className="space-y-2.5 pt-5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className={cn('text-[11px] font-medium capitalize', STATUS_STYLE[flow.status] || STATUS_STYLE.draft)}>
                        {flow.status}
                      </Badge>
                      <div className="flex items-center gap-2">
                        {flow.sharedWithYou && (
                          <Badge variant="outline" className="border-violet-200 bg-violet-50 text-[10px] font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
                            Shared
                          </Badge>
                        )}
                        {/* Swallow clicks here so opening the menu never follows the card Link. */}
                        <div onClick={(event) => { event.preventDefault(); event.stopPropagation() }}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                aria-label={`Actions for ${flow.name}`}
                                disabled={duplicatingId === flow.id}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => void duplicateFlow(flow)}>
                                <Copy /> Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDeleteTarget(flow)}>
                                <Trash2 /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-foreground">
                        <Workflow className="h-[18px] w-[18px]" />
                      </span>
                      <CardTitle className="min-w-0 text-base leading-snug">{flow.name}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="line-clamp-2 text-sm text-muted-foreground">{flow.description || 'No description yet.'}</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />
        </>
      )}

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next) setDeleteTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.name}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the flow and its published version. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (deleteTarget) void deleteFlow(deleteTarget) }}>
              Delete flow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
