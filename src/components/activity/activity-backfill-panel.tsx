'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DownloadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { canonicalIntegrationSlug } from '@/lib/templates/departments'
import { activitySourceLabel } from './activity-source-labels'

type BackfillWindow = '90d' | '1y' | 'all'

/** Exactly the projection GET /api/activity/backfill selects. */
type Backfill = {
  id: string
  source: string
  connectionRef: string
  window: string
  status: string
  eventsIngested: number
  updatedAt: string
}

/** One startable (source, connectionRef) pair. `connectionRef` is whatever the
 *  adapter keys on, which differs per source — see the comments below. */
type Candidate = { source: string; connectionRef: string; label: string }

const WINDOWS: { value: BackfillWindow; label: string }[] = [
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All available history' },
]

/**
 * Sources whose adapter keys its connectionRef on the Nango connection id.
 * Mirrors NANGO_BACKFILL_SOURCES in `@/lib/activity/auto-backfill` — kept as a
 * literal here because that module pulls the whole adapter registry (and
 * Prisma) in with it, which a client component cannot import.
 */
const NANGO_BACKFILL_SOURCES = new Set(['github', 'google_calendar', 'hubspot'])

const STATUS_BADGE: Record<string, 'good' | 'risk' | 'warn' | 'info' | 'secondary'> = {
  done: 'good',
  failed: 'risk',
  partial: 'warn',
  running: 'info',
  pending: 'secondary',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  partial: 'Partly done',
  done: 'Complete',
  failed: 'Failed',
}

const POLL_MS = 5000

/**
 * Start and monitor historical backfills.
 *
 * Backfill already runs automatically the moment a source connects, but only
 * for a 90-day window and only on that one event — this is where an admin
 * reaches further back, or restarts one that failed. The checkpoint contract
 * makes a re-run resume rather than duplicate, so re-starting an existing
 * (source, connection) pair is always safe.
 */
export function ActivityBackfillPanel({ onIngested }: { onIngested?: () => void }) {
  const [backfills, setBackfills] = useState<Backfill[] | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [selected, setSelected] = useState('')
  const [window_, setWindow] = useState<BackfillWindow>('90d')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const loadBackfills = useCallback(async () => {
    const response = await fetch('/api/activity/backfill', { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not load backfills.')
    return (body.backfills ?? []) as Backfill[]
  }, [])

  // Which connections can actually be backfilled. There is no single endpoint
  // for this — each plane holds its own connection records — so the three
  // planes that carry a backfill-capable adapter are read here and unified.
  const loadCandidates = useCallback(async () => {
    const [nango, granola, slack] = await Promise.all([
      fetch('/api/nango/status', { cache: 'no-store' }).then((response) => response.json()).catch(() => ({})),
      fetch('/api/integrations/granola', { cache: 'no-store' }).then((response) => response.json()).catch(() => ({})),
      fetch('/api/slack/connections', { cache: 'no-store' }).then((response) => response.json()).catch(() => ({})),
    ])
    const found: Candidate[] = []

    const connections = (nango?.connections ?? {}) as Record<string, { connected?: boolean; connectionIds?: string[] }>
    for (const [providerConfigKey, connection] of Object.entries(connections)) {
      if (!connection?.connected) continue
      const source = canonicalIntegrationSlug(providerConfigKey)
      if (!NANGO_BACKFILL_SOURCES.has(source)) continue
      const ids = connection.connectionIds ?? []
      for (const connectionId of ids) {
        found.push({
          source,
          connectionRef: connectionId,
          label: ids.length > 1 ? `${activitySourceLabel(source)} · ${connectionId}` : activitySourceLabel(source),
        })
      }
    }

    // Slack's adapter keys on SlackWorkspaceConnection.id, never a Nango id.
    for (const connection of (slack?.connections ?? []) as { id: string; teamName: string | null }[]) {
      found.push({
        source: 'slack',
        connectionRef: connection.id,
        label: connection.teamName ? `Slack · ${connection.teamName}` : 'Slack',
      })
    }

    // Granola authenticates with a workspace API key, so its ref is a constant.
    if (granola?.configured) found.push({ source: 'granola', connectionRef: 'granola', label: 'Granola' })

    return found
  }, [])

  const load = useCallback(async () => {
    try {
      const [rows, options] = await Promise.all([loadBackfills(), loadCandidates()])
      setBackfills(rows)
      setCandidates(options)
      setError('')
    } catch (cause) {
      setBackfills((current) => current ?? [])
      setCandidates((current) => current ?? [])
      setError(cause instanceof Error ? cause.message : 'Could not load backfills.')
    }
  }, [loadBackfills, loadCandidates])

  useEffect(() => { void load() }, [load])

  const inFlight = Boolean(backfills?.some((row) => row.status === 'pending' || row.status === 'running'))

  // Progress lives only in the row, so a running backfill is polled until it
  // settles — otherwise "Running · 0 events" is the last thing anyone sees.
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => {
      loadBackfills()
        .then((rows) => {
          setBackfills(rows)
          onIngested?.()
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, loadBackfills, onIngested])

  const options = useMemo(() => candidates ?? [], [candidates])

  const start = async () => {
    const candidate = options.find((option) => `${option.source}:${option.connectionRef}` === selected)
    if (!candidate) return
    setStarting(true)
    try {
      const response = await fetch('/api/activity/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: candidate.source, connectionRef: candidate.connectionRef, window: window_ }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not start the backfill.')
      toast.success(
        body.mode === 'queued'
          ? `Backfilling ${candidate.label}. Progress appears below.`
          : `Backfilling ${candidate.label} in the foreground — it imports in batches, so start it again to continue.`,
      )
      setBackfills(await loadBackfills())
      onIngested?.()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not start the backfill.')
    } finally {
      setStarting(false)
    }
  }

  if (!backfills || !candidates) return <Skeleton className="h-48 rounded-xl" />

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Import history</p>
        <p className="text-xs text-muted-foreground">
          Connected tools start a 90-day import automatically. Reach further back, or restart a failed import, here —
          re-running one resumes from its checkpoint rather than duplicating events.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No connected source supports history import yet. Connect Slack, GitHub, HubSpot, Google Calendar, or Granola first.
        </p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="backfill-source">Source</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="backfill-source"><SelectValue placeholder="Choose a connection" /></SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={`${option.source}:${option.connectionRef}`} value={`${option.source}:${option.connectionRef}`}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:w-52">
            <Label htmlFor="backfill-window">History</Label>
            <Select value={window_} onValueChange={(value) => setWindow(value as BackfillWindow)}>
              <SelectTrigger id="backfill-window"><SelectValue /></SelectTrigger>
              <SelectContent>
                {WINDOWS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button loading={starting} disabled={starting || !selected} onClick={() => void start()}>
            <DownloadCloud className="mr-1.5 h-4 w-4" />Import
          </Button>
        </div>
      )}

      {backfills.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          {backfills.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{activitySourceLabel(row.source)}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {WINDOWS.find((option) => option.value === row.window)?.label ?? row.window}
                  {' · '}{row.eventsIngested.toLocaleString()} event{row.eventsIngested === 1 ? '' : 's'}
                  {' · updated '}{new Date(row.updatedAt).toLocaleString()}
                </p>
              </div>
              <Badge variant={STATUS_BADGE[row.status] ?? 'secondary'}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
