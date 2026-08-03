'use client'

import { useCallback, useEffect, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { activitySourceLabel } from './activity-source-labels'

/** Exactly the projection GET /api/activity selects. */
export type ActivityEvent = {
  id: string
  source: string
  actorName: string | null
  action: string
  entityType: string
  entityName: string | null
  outcome: string | null
  occurredAt: string
  ingestKind: 'backfill' | 'webhook' | 'sync'
}

const PAGE_SIZE = 50

const INGEST_LABELS: Record<string, string> = {
  backfill: 'History',
  webhook: 'Live',
  sync: 'Sync',
}

/**
 * The workspace activity ledger — the normalized cross-tool event stream that
 * webhooks, backfills, and the daily sync all write into.
 *
 * Paging is cursor-based (the API returns `nextCursor`, not a page count), so
 * this appends with "Load more" rather than using the client-side `Pagination`
 * component, which needs the whole list up front.
 */
export function ActivityFeed({ sources }: { sources: string[] }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [source, setSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const fetchPage = useCallback(async (activeSource: string, after: string | null) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (activeSource) params.set('source', activeSource)
    if (after) params.set('cursor', after)
    const response = await fetch(`/api/activity?${params.toString()}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not load workspace activity.')
    return body as { events: ActivityEvent[]; nextCursor: string | null }
  }, [])

  const reload = useCallback(async (activeSource: string) => {
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(activeSource, null)
      setEvents(page.events ?? [])
      setCursor(page.nextCursor ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load workspace activity.')
    } finally {
      setLoading(false)
    }
  }, [fetchPage])

  useEffect(() => { void reload(source) }, [reload, source])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(source, cursor)
      setEvents((current) => [...current, ...(page.events ?? [])])
      setCursor(page.nextCursor ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load more activity.')
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setSource('')}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${source === '' ? 'border-transparent bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        >
          All sources
        </button>
        {sources.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSource(key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${source === key ? 'border-transparent bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {activitySourceLabel(key)}
          </button>
        ))}
        <Button
          variant="outline"
          size="icon"
          className="ml-auto"
          onClick={() => void reload(source)}
          disabled={loading}
          aria-label="Refresh activity"
          title="Refresh activity"
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
          <p>{error}</p>
          <Button className="mt-2" variant="outline" size="sm" onClick={() => void reload(source)}>Try again</Button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={`activity-skeleton-${index}`} className="h-11 rounded-lg" />)}
        </div>
      ) : events.length === 0 && !error ? (
        <EmptyState
          icon={History}
          title="No activity yet"
          description="Connected tools write here as they are used. Run a backfill below to bring in what already happened."
        />
      ) : events.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Captured</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(event.occurredAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{activitySourceLabel(event.source)}</TableCell>
                    <TableCell className="text-sm">{event.actorName || '—'}</TableCell>
                    <TableCell className="text-sm">
                      <span className="font-medium">{event.action}</span>
                      <span className="text-muted-foreground"> · {event.entityName || event.entityType}</span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{event.outcome || '—'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{INGEST_LABELS[event.ingestKind] ?? event.ingestKind}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-center gap-3">
            {cursor ? (
              <Button variant="outline" size="sm" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {events.length} event{events.length === 1 ? '' : 's'} · end of history
              </span>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
