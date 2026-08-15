'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Bot, ListTree, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { TraceTimeline } from '@/components/traces/trace-timeline'
import { fmtDurationMs, type TraceStatus } from '@/lib/traces/envelope'
import type { TraceDetail } from '@/lib/traces/spans'

/**
 * One run's full trace: header facts (status, duration, tokens, cost,
 * trigger) over the span timeline. Polls while the run is live (3s — the
 * agent pane's refresh idiom, no new realtime channel) and stops on terminal
 * states. A 404 renders as absence: the run may be another user's, another
 * org's, or pruned — all indistinguishable by design.
 */

const STATUS_BADGE: Record<TraceStatus, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  succeeded: 'good',
  failed: 'risk',
  running: 'info',
  queued: 'info',
  waiting: 'warn',
  stopped: 'outline',
}

const LIVE_STATUSES: TraceStatus[] = ['queued', 'running', 'waiting']

const fmtTokens = (tokens: { input: number; output: number }): string =>
  `${(tokens.input + tokens.output).toLocaleString()} tokens`

export default function TraceDetailPage() {
  const params = useParams<{ kind: string; id: string }>()
  const kind = params?.kind
  const id = params?.id
  const validKind = kind === 'agent' || kind === 'flow'
  const [trace, setTrace] = useState<TraceDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!validKind || !id) return
    try {
      const response = await fetch(`/api/traces/${kind}/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (response.status === 404) {
        setNotFound(true)
        return
      }
      if (!response.ok) return // transient — keep whatever is on screen
      const body = await response.json()
      if (body?.trace) setTrace(body.trace)
    } catch {
      // Transient network failure: keep the current view; polling retries.
    } finally {
      setLoading(false)
    }
  }, [validKind, kind, id])

  useEffect(() => {
    void load()
  }, [load])

  // Live runs re-poll until they reach a terminal status.
  useEffect(() => {
    if (!trace || !LIVE_STATUSES.includes(trace.summary.status)) return
    const handle = setInterval(() => void load(), 3000)
    return () => clearInterval(handle)
  }, [trace, load])

  if (!validKind) {
    return (
      <EmptyState
        icon={ListTree}
        title="Unknown trace kind"
        description="Traces are either agent runs or flow runs."
        action={
          <Link href="/traces" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            Back to traces
          </Link>
        }
      />
    )
  }
  if (notFound) {
    return (
      <EmptyState
        icon={ListTree}
        title="Trace not found"
        description="This run doesn't exist in your workspace — it may have been pruned."
        action={
          <Link href="/traces" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">
            Back to traces
          </Link>
        }
      />
    )
  }
  if (loading || !trace) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading trace">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  const { summary, spans } = trace
  const KindIcon = summary.kind === 'agent' ? Bot : Workflow
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/traces"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" /> All traces
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <KindIcon aria-hidden className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{summary.name}</h1>
          <Badge variant={STATUS_BADGE[summary.status]}>{summary.status}</Badge>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="tabular-nums">{fmtDurationMs(summary.durationMs)}</span>
          {summary.tokens && <span className="tabular-nums">{fmtTokens(summary.tokens)}</span>}
          {summary.costUsd !== null && <span className="tabular-nums">${summary.costUsd.toFixed(2)}</span>}
          {summary.trigger && <span>trigger: {summary.trigger}</span>}
          <span className="tabular-nums">{new Date(summary.startedAt).toLocaleString()}</span>
        </p>
        {summary.error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            {summary.error}
          </p>
        )}
      </div>
      <TraceTimeline spans={spans} />
    </div>
  )
}
