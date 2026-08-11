'use client'

/**
 * Workspace insights, admin-only: adoption (is my team using this?),
 * contribution (who is moving the numbers?), and the restricted-goals roll-up
 * (what is hidden, and from whom?).
 *
 * The tab is hidden from non-admins by the shell, but that is presentation —
 * the API refuses a MEMBER independently (insights:workspace).
 */

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCachedJson } from '@/lib/client/use-cached-json'
import type { Member } from './types'

type AdoptionRow = {
  userId: string
  name: string | null
  email: string | null
  lastActiveAt: string | null
  runs: number
  flowsCreated: number
  agentsCreated: number
  tokensUsed: number
}

type ContributionRow = {
  goalId: string
  name: string
  riskLevel: string
  contributions: number
  pending: number
  used: number
  skipped: number
}

type InsightsResponse = {
  success?: boolean
  windowDays?: number
  adoption?: AdoptionRow[]
  contribution?: ContributionRow[]
  headline?: { members: number; neverActive: number }
}

type GoalsResponse = { goals?: Array<{ id: string; name: string; personal?: boolean; restricted?: boolean }> }
type QueueResponse = {
  queues?: {
    transport?: Record<string, unknown>
    runs?: Record<string, number>
    outbox?: Record<string, number>
    effects?: Record<string, number>
    learning?: { observations: number; feedback: number }
    oldestPendingAt?: string | null
    expiredLeases?: number
  }
  deadLetters?: Array<{
    id: string; queue: string; executionType: string; executionId?: string | null; error: string
    status: string; replayAttempts: number; lastReplayError?: string | null; createdAt: string
  }>
}

function relativeDay(iso: string | null): string {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

export function InsightsTab({ members }: Readonly<{ members: Member[] }>) {
  const { data, loading } = useCachedJson<InsightsResponse>('/api/settings/insights')
  const adoption = data?.adoption ?? []
  const contribution = data?.contribution ?? []
  const headline = data?.headline

  if (loading && !data) {
    return <div className="space-y-4"><Skeleton className="h-40 max-w-3xl rounded-xl" /><Skeleton className="h-40 max-w-3xl rounded-xl" /></div>
  }

  return (
    <div className="space-y-6">
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Team adoption</CardTitle>
          <CardDescription>
            {/* The line an admin acts on. Never-active members are listed, not
                omitted — surfacing who needs help is the point. */}
            {headline && headline.neverActive > 0
              ? `${headline.neverActive} of ${headline.members} members have never been active.`
              : `Activity across ${headline?.members ?? 0} members, last ${data?.windowDays ?? 30} days.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Member</th>
                <th className="py-2 pr-3 font-medium">Last active</th>
                <th className="py-2 pr-3 text-right font-medium">Runs</th>
                <th className="py-2 pr-3 text-right font-medium">Flows</th>
                <th className="py-2 pr-3 text-right font-medium">Agents</th>
                {/* "of org pool": credits are org-wide, a per-seat figure would
                    describe an allowance that does not exist. */}
                <th className="py-2 text-right font-medium">Tokens (of org pool)</th>
              </tr>
            </thead>
            <tbody>
              {adoption.map((row) => (
                <tr key={row.userId} className="border-b last:border-0">
                  <td className="max-w-40 truncate py-2 pr-3 font-medium">{row.name || row.email || 'Member'}</td>
                  <td className={`py-2 pr-3 ${row.lastActiveAt ? 'text-muted-foreground' : 'text-amber-600'}`}>{relativeDay(row.lastActiveAt)}</td>
                  <td className="py-2 pr-3 text-right">{row.runs}</td>
                  <td className="py-2 pr-3 text-right">{row.flowsCreated}</td>
                  <td className="py-2 pr-3 text-right">{row.agentsCreated}</td>
                  <td className="py-2 text-right">{row.tokensUsed.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Goal contribution</CardTitle>
          <CardDescription>Who is moving the numbers — linked work and throughput per organization goal.</CardDescription>
        </CardHeader>
        <CardContent>
          {contribution.length === 0 ? (
            <p className="text-sm text-muted-foreground">No organization goals yet.</p>
          ) : (
            <div className="space-y-2">
              {contribution.map((row) => (
                <div key={row.goalId} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.contributions} linked · {row.pending} pending · {row.used} used · {row.skipped} skipped
                    </p>
                  </div>
                  {row.riskLevel === 'at_risk' || row.riskLevel === 'off_track' ? (
                    <Badge variant="outline" className="border-amber-300 text-amber-700">at risk</Badge>
                  ) : null}
                  {row.contributions === 0 && (
                    <Badge variant="outline" className="text-muted-foreground">nobody assigned</Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RestrictedGoalsCard members={members} />
      <QueueOperationsCard />
    </div>
  )
}

function QueueOperationsCard() {
  const { data, loading, refresh } = useCachedJson<QueueResponse>('/api/system/queues')
  const [replaying, setReplaying] = useState<string | null>(null)
  const replay = async (id: string) => {
    setReplaying(id)
    try {
      await fetch('/api/system/queues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'replay', deadLetterId: id }),
      })
      await refresh()
    } finally {
      setReplaying(null)
    }
  }
  const outbox = data?.queues?.outbox ?? {}
  const runs = data?.queues?.runs ?? {}
  const effects = data?.queues?.effects ?? {}
  const open = (data?.deadLetters ?? []).filter((row) => row.status === 'open' || row.status === 'replay_failed')
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Flow queue operations</CardTitle>
        <CardDescription>Durable dispatch, worker leases, side-effect safety, and dead-letter replay.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !data ? <Skeleton className="h-20 rounded-lg" /> : (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">Queued / claimed</p><p className="font-semibold">{(runs.queued ?? 0) + (runs.claimed ?? 0)}</p></div>
            <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">Outbox pending</p><p className="font-semibold">{(outbox.pending ?? 0) + (outbox.failed ?? 0)}</p></div>
            <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">Ambiguous effects</p><p className="font-semibold">{effects.ambiguous ?? 0}</p></div>
            <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">Open dead letters</p><p className="font-semibold">{open.length}</p></div>
            <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">Expired leases</p><p className="font-semibold">{data?.queues?.expiredLeases ?? 0}</p></div>
          </div>
        )}
        {data?.queues?.oldestPendingAt && <p className="text-xs text-muted-foreground">Oldest pending dispatch: {new Date(data.queues.oldestPendingAt).toLocaleString()}</p>}
        {open.length === 0 ? <p className="text-sm text-muted-foreground">No replayable dead letters.</p> : (
          <div className="space-y-2">
            {open.map((row) => (
              <div key={row.id} className="flex items-start gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{row.executionType} · {row.queue}</p>
                  <p className="truncate text-xs text-muted-foreground">{row.error}</p>
                  {row.lastReplayError && <p className="mt-1 text-xs text-red-600">{row.lastReplayError}</p>}
                </div>
                <Button variant="outline" size="sm" loading={replaying === row.id} onClick={() => void replay(row.id)}>Replay</Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Which goals are hidden, and from whom — the question the per-goal Access
 * control structurally cannot answer. Reads members per restricted goal;
 * restriction is rare by nature, so this is a handful of requests (the spec's
 * threshold for a dedicated list endpoint is >10 restricted goals).
 */
function RestrictedGoalsCard({ members }: Readonly<{ members: Member[] }>) {
  const { data: goalsData } = useCachedJson<GoalsResponse>('/api/goals')
  const restricted = (goalsData?.goals ?? []).filter((goal) => goal.restricted && !goal.personal)
  const [memberships, setMemberships] = useState<Record<string, string[]>>({})

  useEffect(() => {
    let cancelled = false
    Promise.all(
      restricted.map(async (goal) => {
        const response = await fetch(`/api/goals/${goal.id}/members`, { cache: 'no-store' })
        const body = await response.json().catch(() => ({}))
        return [goal.id, (body.members ?? []).map((row: { userId: string }) => row.userId)] as const
      }),
    ).then((entries) => { if (!cancelled) setMemberships(Object.fromEntries(entries)) })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restricted.map((goal) => goal.id).join(',')])

  if (restricted.length === 0) return null
  const nameFor = (userId: string) =>
    members.find((member) => member.id === userId)?.name
    ?? members.find((member) => member.id === userId)?.email
    ?? 'Former member'

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Restricted goals</CardTitle>
        <CardDescription>Hidden from everyone except the listed members and workspace admins.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {restricted.map((goal) => (
          <div key={goal.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{goal.name}</p>
            <p className="text-xs text-muted-foreground">
              {(memberships[goal.id] ?? []).length === 0
                ? 'Admins only'
                : (memberships[goal.id] ?? []).map(nameFor).join(', ')}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
