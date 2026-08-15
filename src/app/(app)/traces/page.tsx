'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bot, ListTree, Search, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { fmtDurationMs, type TraceStatus, type TraceSummary } from '@/lib/traces/envelope'

/**
 * Workspace trace explorer: every agent execution and flow run the viewer may
 * see, one merged stream. Workspace-level (not /g/[scope]) like Activity —
 * runs are an org stream with no goal dimension. Visibility is the run
 * stores' own rules; this page can never show more than the panes it unifies.
 */

type TraceRow = TraceSummary & { resource?: { agentTaskId?: string | null; flowId?: string } }

const STATUS_BADGE: Record<TraceStatus, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  succeeded: 'good',
  failed: 'risk',
  running: 'info',
  queued: 'info',
  waiting: 'warn',
  stopped: 'outline',
}

const KIND_FILTERS = [
  { key: '', label: 'All' },
  { key: 'agent', label: 'Agents' },
  { key: 'flow', label: 'Flows' },
] as const

const STATUS_FILTERS: Array<{ key: '' | TraceStatus; label: string }> = [
  { key: '', label: 'Any status' },
  { key: 'running', label: 'Running' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'stopped', label: 'Stopped' },
  { key: 'queued', label: 'Queued' },
]

const relativeTime = (iso: string): string => {
  const deltaMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const fmtTokens = (tokens: { input: number; output: number }): string => {
  const total = tokens.input + tokens.output
  return total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M tok` : `${Math.round(total / 1000)}k tok`
}

export default function TracesPage() {
  const [traces, setTraces] = useState<TraceRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [kind, setKind] = useState<(typeof KIND_FILTERS)[number]['key']>('')
  const [status, setStatus] = useState<'' | TraceStatus>('')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('') // debounced q
  const generation = useRef(0)

  useEffect(() => {
    const handle = setTimeout(() => setQuery(q.trim()), 300)
    return () => clearTimeout(handle)
  }, [q])

  const load = useCallback(
    async (append: boolean, afterCursor: string | null) => {
      const requestId = append ? generation.current : ++generation.current
      const params = new URLSearchParams()
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      if (query) params.set('q', query)
      if (append && afterCursor) params.set('cursor', afterCursor)
      try {
        const response = await fetch(`/api/traces?${params.toString()}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const body = await response.json()
        if (requestId !== generation.current) return // a newer filter superseded this request
        setTraces((current) => (append ? [...current, ...(body.traces ?? [])] : (body.traces ?? [])))
        setCursor(body.cursor ?? null)
        setError(false)
      } catch {
        if (requestId === generation.current) setError(true)
      } finally {
        if (requestId === generation.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [kind, status, query],
  )

  useEffect(() => {
    setLoading(true)
    void load(false, null)
  }, [load])

  const loadMore = () => {
    setLoadingMore(true)
    void load(true, cursor)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        icon={ListTree}
        title="Traces"
        description="Every agent and flow run — the tools they called, the context they retrieved, and what it cost."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Filter by kind">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.key || 'all'}
              type="button"
              onClick={() => setKind(filter.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                kind === filter.key
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.key || 'any'}
              type="button"
              onClick={() => setStatus(filter.key)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                status === filter.key
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full max-w-xs">
          <Search aria-hidden className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search by agent or flow name"
            aria-label="Search traces by agent or flow name"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading traces">
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
      ) : error ? (
        <EmptyState
          icon={ListTree}
          title="Couldn't load traces"
          description="Something went wrong reading the run stream. Try again."
          action={<Button onClick={() => void load(false, null)}>Retry</Button>}
        />
      ) : traces.length === 0 ? (
        <EmptyState
          icon={ListTree}
          title="No runs yet"
          description="Runs will appear here when your agents and flows do work."
        />
      ) : (
        <>
          <ul className="overflow-hidden rounded-xl border bg-card shadow-1">
            {traces.map((trace) => {
              const KindIcon = trace.kind === 'agent' ? Bot : Workflow
              return (
                <li key={`${trace.kind}-${trace.id}`} className="border-b last:border-b-0">
                  <Link
                    href={`/traces/${trace.kind}/${trace.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-accent"
                  >
                    <KindIcon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="sr-only">{trace.kind === 'agent' ? 'Agent run' : 'Flow run'}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{trace.name}</span>
                    <Badge variant={STATUS_BADGE[trace.status]}>{trace.status}</Badge>
                    <span className="tabular-nums text-xs text-muted-foreground">{relativeTime(trace.startedAt)}</span>
                    <span className="tabular-nums text-xs text-muted-foreground">{fmtDurationMs(trace.durationMs)}</span>
                    {trace.tokens && (
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {fmtTokens(trace.tokens)}
                        {trace.costUsd !== null && ` · $${trace.costUsd.toFixed(2)}`}
                      </span>
                    )}
                    <span className="tabular-nums text-xs text-muted-foreground">
                      {trace.toolCallCount} {trace.kind === 'agent' ? 'tools' : 'steps'}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
          {cursor && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
