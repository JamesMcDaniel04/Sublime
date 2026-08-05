'use client'

import { useCallback, useMemo, useState } from 'react'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { ALL_SCOPE, useScope } from '@/lib/client/scoped-href'
import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { toast } from 'sonner'
import { CircleOff, Copy, MoreHorizontal, Plus, Sparkles, Trash2, Upload, Workflow, X } from 'lucide-react'
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
import { invalidateCachedJson, useCachedJson } from '@/lib/client/use-cached-json'
import { STARTER_TEMPLATES } from '@/lib/flows/starter-templates'
import { TemplateCatalogueCard } from '@/components/templates/template-catalogue-card'
import { ImportFlowDialog } from '@/components/flows/import-flow-dialog'

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

/**
 * The full learning-stage breakdown from /api/intelligence/readiness. The
 * `suggestionReadiness` bundled into /api/flows only covers the ORG gates, so
 * a user past those but with no eligible pattern yet saw a silent wall.
 */
type LearningReadiness = {
  connections: { total: number; needed: number; ready: boolean }
  usage: { events: number; needed: number; ready: boolean }
  personal: {
    hasActivity: boolean
    learningDaysLeft: number
    inLearningPeriod: boolean
    eligiblePatterns: number
    openSuggestion: boolean
  }
  ready: boolean
}
type ReadinessResponse = { success?: boolean; readiness?: LearningReadiness }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * One sentence naming the stage that is actually blocking suggestions.
 * Returns null for the connections gate — the banner above the grid already
 * says that, and repeating it in the empty state reads as a bug.
 */
function suggestionExplainer(readiness: LearningReadiness | null | undefined): string | null {
  if (!readiness) return null
  if (!readiness.connections.ready) return null
  if (!readiness.usage.ready) {
    return `Your tools are connected. Sublime needs ${plural(readiness.usage.needed, 'more recorded action')} before it can suggest a flow.`
  }
  const { personal } = readiness
  if (!personal.hasActivity) {
    return 'Your workspace is ready, but Sublime has not seen any of your activity yet. Keep working in your connected tools and suggestions will follow.'
  }
  if (personal.eligiblePatterns === 0) {
    return personal.inLearningPeriod
      ? `Sublime is still learning how you work — about ${plural(personal.learningDaysLeft, 'day')} to go before it starts suggesting flows.`
      : 'Sublime is watching your work but has not seen a task repeat often enough to be worth automating yet.'
  }
  if (personal.openSuggestion) {
    return 'Sublime has a suggestion in progress — it will appear here once the draft is ready.'
  }
  return `Sublime spotted ${plural(personal.eligiblePatterns, 'repeating pattern')} in your work and is drafting suggestions from ${personal.eligiblePatterns === 1 ? 'it' : 'them'}.`
}

const STATUS_STYLE: Record<string, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  draft: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  disabled: 'border-border bg-muted text-muted-foreground',
}

type FlowsResponse = { success?: boolean; error?: string; flows?: FlowItem[]; suggestionReadiness?: SuggestionReadiness | null; unlinkedCount?: number }

export default function FlowsPage() {
  const router = useScopedRouter()
  // Stale-while-revalidate: paint instantly from the client cache (warmed at
  // sign-in by the sidebar) and refresh in the background — the previous
  // fetch-on-mount pattern blocked every visit on a network round-trip.
  // The scope is part of the cache key, so switching goals cannot repaint the
  // previous lens's rows from cache before the new response lands.
  const scope = useScope()
  const flowsUrl = `/api/flows?goal=${encodeURIComponent(scope)}`
  const { data, loading, error, refresh, mutate } = useCachedJson<FlowsResponse>(flowsUrl)
  const flows = useMemo(() => data?.flows ?? [], [data])
  const unlinkedCount = data?.unlinkedCount ?? 0
  const [showUnlinked, setShowUnlinked] = useState(false)
  // Fetched only once asked for, so the common case pays nothing for it.
  // useCachedJson treats a null url as "don't fetch".
  const unlinkedUrl = showUnlinked && scope !== ALL_SCOPE ? `${flowsUrl}&unlinked=1` : null
  const { data: unlinkedData } = useCachedJson<FlowsResponse>(unlinkedUrl)

  const attachToGoal = useCallback(async (flowId: string) => {
    const response = await fetch(`/api/goals/${scope}/contributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceType: 'flow', resourceId: flowId }),
    })
    if (!response.ok) {
      toast.error('Could not link that flow to this goal.')
      return
    }
    // Both lenses changed, so both cache keys have to go.
    invalidateCachedJson(flowsUrl)
    invalidateCachedJson(`${flowsUrl}&unlinked=1`)
    await refresh()
  }, [scope, flowsUrl, refresh])
  const readiness = data?.suggestionReadiness ?? null
  const loadError = error ? (error instanceof Error ? error.message : 'Could not load flows.') : ''
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FlowItem | null>(null)
  const [disableTarget, setDisableTarget] = useState<FlowItem | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const suggestedFlows = useMemo(() => flows.filter((flow) => flow.suggested && flow.status === 'draft'), [flows])
  const otherFlows = useMemo(() => flows.filter((flow) => !(flow.suggested && flow.status === 'draft')), [flows])

  // Explain the empty state rather than showing a bare wall. Same
  // fetch-only-when-asked-for pattern as `unlinkedUrl` above: a null url means
  // useCachedJson does not fetch, so a workspace with flows never pays for it.
  const showEmptyState = !loading && !loadError && otherFlows.length === 0 && suggestedFlows.length === 0
  const { data: readinessData } = useCachedJson<ReadinessResponse>(
    showEmptyState ? '/api/intelligence/readiness' : null,
  )
  const explainer = suggestionExplainer(readinessData?.readiness)

  const dismissSuggestion = async (id: string) => {
    setDismissingId(id)
    const previous = data
    mutate({ ...data, flows: flows.filter((flow) => flow.id !== id) })
    try {
      const response = await fetch(`/api/flows/${id}/dismiss-suggestion`, { method: 'POST' })
      if (!response.ok) {
        if (previous) mutate(previous)
        toast.error('Could not dismiss that suggestion.')
      } else {
        void refresh()
      }
    } catch {
      if (previous) mutate(previous)
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
      const body = await response.json().catch(() => ({}))
      if (response.ok && body.flow) {
        // Background refresh keeps the list cache warm (an invalidate would
        // make the next /flows visit block on an empty cache again).
        void refresh()
        router.push(`/flows/${body.flow.id}`)
      }
      else toast.error(body.error || 'Could not create the flow.')
    } catch {
      toast.error('Could not create the flow.')
    } finally {
      setCreating(false)
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
      const body = await response.json().catch(() => ({}))
      if (response.ok && body.flow) {
        void refresh()
        router.push(`/flows/${body.flow.id}`)
      } else {
        toast.error(body.error || 'Could not duplicate the flow.')
      }
    } catch {
      toast.error('Could not duplicate the flow.')
    } finally {
      setDuplicatingId(null)
    }
  }

  /** Optimistic disable: flip the card to disabled immediately, restore + toast on failure. */
  const disableFlow = async (flow: FlowItem) => {
    const previous = data
    mutate({ ...data, flows: flows.map((entry) => (entry.id === flow.id ? { ...entry, status: 'disabled' } : entry)) })
    setDisableTarget(null)
    try {
      const response = await fetch(`/api/flows/${flow.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable: true }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error)
      }
      void refresh()
    } catch (cause) {
      if (previous) mutate(previous)
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not disable the flow.')
    }
  }

  /** Optimistic delete: remove the card immediately, restore + toast on failure. */
  const deleteFlow = async (flow: FlowItem) => {
    const previous = data
    mutate({ ...data, flows: flows.filter((entry) => entry.id !== flow.id) })
    setDeleteTarget(null)
    try {
      const response = await fetch('/api/flows', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: flow.id }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error)
      }
      void refresh()
    } catch (cause) {
      if (previous) mutate(previous)
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not delete the flow.')
    }
  }

  const { pageItems, pageCount, page: current } = paginate(otherFlows, page, PAGE_SIZE)

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Pipelines" icon={Workflow} title="Flows" description="Wire your agents into deterministic multi-step pipelines." />
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 h-4 w-4" /> Import
          </Button>
          <Button onClick={createFlow} loading={creating}>
            <Plus className="mr-1.5 h-4 w-4" /> New flow
          </Button>
        </div>
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

      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`flow-skeleton-${i}`} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><p className="font-medium">Your flows could not be loaded.</p><p className="mt-1">{loadError}</p><Button className="mt-3" variant="outline" onClick={() => void refresh()}>Try again</Button></div>
      ) : otherFlows.length === 0 ? (
        suggestedFlows.length === 0 ? (
          <div className="space-y-3">
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
            {explainer && (
              <p className="px-6 text-center text-xs text-muted-foreground">{explainer}</p>
            )}
          </div>
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
                              {/* A live flow is disabled first — permanent
                                  delete is only offered once it's disabled,
                                  so destroying a live flow is never 1 click. */}
                              {flow.status === 'disabled' ? (
                                <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDeleteTarget(flow)}>
                                  <Trash2 /> Delete
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDisableTarget(flow)}>
                                  <CircleOff /> Disable
                                </DropdownMenuItem>
                              )}
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
          {/* Hidden work is always COUNTED. A lens that silently drops flows
              teaches people not to trust it — and the first time someone thinks
              a flow was deleted, they stop using the switcher. */}
          {scope !== ALL_SCOPE && unlinkedCount > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowUnlinked((open) => !open)}
                className="w-full rounded-md border border-dashed p-3 text-left text-sm text-muted-foreground hover:bg-muted/50"
              >
                {unlinkedCount} {unlinkedCount === 1 ? 'flow' : 'flows'} not linked to this goal ›
              </button>
              {showUnlinked && (
                <div className="mt-2 space-y-2">
                  {(unlinkedData?.flows ?? []).map((flow) => (
                    <div key={flow.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                      <span className="flex-1 truncate">{flow.name}</span>
                      <Button size="sm" variant="outline" onClick={() => void attachToGoal(flow.id)}>
                        Link to goal
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Starter templates live BELOW the user's own flows (Monday-style):
          your work first, ready-made starting points underneath. */}
      {!loading && !loadError && (
        <div className="space-y-3 border-t pt-6">
          <div>
            <p className="text-sm font-semibold">Start with a template</p>
            <p className="text-xs text-muted-foreground">
              Preview the finished output, copy its Copilot build instructions, or create it as-is.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {STARTER_TEMPLATES.map((template) => (
              <TemplateCatalogueCard
                key={template.key}
                href={`/flows/templates/${template.key}`}
                name={template.name}
                description={template.description}
                category={template.category}
                integrations={template.requires}
                kind="flow"
                actionLabel="View template"
              />
            ))}
          </div>
        </div>
      )}

      <Dialog open={Boolean(disableTarget)} onOpenChange={(next) => { if (!next) setDisableTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disable “{disableTarget?.name}”?</DialogTitle>
            <DialogDescription>
              Scheduled runs and webhook triggers stop firing, and agents can no longer call this flow. It stays here with its history — open it and publish to re-enable, or delete it permanently once disabled.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (disableTarget) void disableFlow(disableTarget) }}>
              Disable flow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <ImportFlowDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(flowId) => {
          setImportOpen(false)
          void refresh()
          router.push(`/flows/${flowId}`)
        }}
      />
    </div>
  )
}
