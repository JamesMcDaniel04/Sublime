'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Archive, Pencil, Plus, RefreshCw, Target } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ContributionPanel, type Contribution } from '@/components/goals/contribution-panel'
import { fmtValue } from '@/components/goals/chart-math'
import { GoalTrendChart, RiskBadge } from '@/components/goals/goal-viz'
import type { GoalSummary } from '@/lib/types'
import type { ImpactTiers } from '@/components/goals/impact-strip'
import { periodLabel } from '@/lib/goals/recurrence'

type Datapoint = {
  id: string
  value: number
  capturedAt: string
  origin: 'sync' | 'manual' | 'backfill'
}

type Detail = Omit<GoalSummary, 'sparkline'> & {
  description: string | null
  projectedValue: number | null
  metric: (GoalSummary['metric'] & { id: string }) | null
  children: Array<{
    id: string | null
    name: string
    riskLevel: GoalSummary['riskLevel']
    personal: boolean
  }>
  periods: Array<{
    periodStart: string
    periodEnd: string
    targetValue: number
    finalValue: number
    outcome: 'achieved' | 'missed'
  }>
  benchmark: {
    orgCount: number
    achievedRate: number
    topSeeds: Array<{ seedKey: string; name: string; deploys: number }>
  } | null
}

type Loaded = {
  goal: Detail
  datapoints: Datapoint[]
  contributions: Contribution[]
  impact: ImpactTiers
}

export default function GoalDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const goalId = params.id
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [recordOpen, setRecordOpen] = useState(false)
  const [edit, setEdit] = useState({
    name: '',
    targetValue: '',
    targetDate: '',
    recurrence: null as GoalSummary['recurrence'],
  })
  const [record, setRecord] = useState({ value: '', capturedAt: '' })

  const load = useCallback(async () => {
    try {
      setError(null)
      const [goalResponse, pointsResponse, contributionsResponse] = await Promise.all([
        fetch(`/api/goals/${goalId}`, { cache: 'no-store' }),
        fetch(`/api/goals/${goalId}/datapoints`, { cache: 'no-store' }),
        fetch(`/api/goals/${goalId}/contributions`, { cache: 'no-store' }),
      ])
      const [goalBody, pointsBody, contributionsBody] = await Promise.all([
        goalResponse.json(),
        pointsResponse.json(),
        contributionsResponse.json(),
      ])
      if (!goalResponse.ok || !pointsResponse.ok || !contributionsResponse.ok) {
        throw new Error(
          goalBody.error ||
            pointsBody.error ||
            contributionsBody.error ||
            'Could not load goal.',
        )
      }
      setLoaded({
        goal: goalBody.goal,
        datapoints: pointsBody.datapoints,
        contributions: contributionsBody.contributions,
        impact: contributionsBody.impact,
      })
      setEdit({
        name: goalBody.goal.name,
        targetValue: String(goalBody.goal.targetValue),
        targetDate: String(goalBody.goal.targetDate).slice(0, 10),
        recurrence: goalBody.goal.recurrence,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load goal.')
    }
  }, [goalId])

  useEffect(() => {
    void load()
  }, [load])

  const chartGoal = useMemo<GoalSummary | null>(
    () =>
      loaded
        ? {
            ...loaded.goal,
            sparkline: loaded.datapoints.map((point) => ({
              value: point.value,
              capturedAt: point.capturedAt,
            })),
          }
        : null,
    [loaded],
  )

  const saveEdit = async () => {
    const response = await fetch(`/api/goals/${goalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: edit.name,
        targetValue: Number(edit.targetValue),
        targetDate: new Date(`${edit.targetDate}T23:59:59`).toISOString(),
        recurrence: edit.recurrence,
      }),
    })
    const body = await response.json()
    if (!response.ok) return toast.error(body.error || 'Could not update goal.')
    await load()
    setEditOpen(false)
    toast.success('Goal updated.')
  }

  const archive = async () => {
    const response = await fetch(`/api/goals/${goalId}`, { method: 'DELETE' })
    const body = await response.json()
    if (!response.ok) return toast.error(body.error || 'Could not archive goal.')
    toast.success('Goal archived.')
    router.push('/goals')
  }

  const recordValue = async () => {
    const response = await fetch(`/api/goals/${goalId}/datapoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: Number(record.value),
        ...(record.capturedAt
          ? { capturedAt: new Date(`${record.capturedAt}T12:00:00`).toISOString() }
          : {}),
      }),
    })
    const body = await response.json()
    if (!response.ok) return toast.error(body.error || 'Could not record value.')
    await load()
    setRecordOpen(false)
    setRecord({ value: '', capturedAt: '' })
    toast.success('Value recorded and risk re-evaluated.')
  }

  if (error) {
    return (
      <EmptyState
        icon={RefreshCw}
        title="Goal could not load"
        description={error}
        action={<Button onClick={() => void load()}>Try again</Button>}
      />
    )
  }
  if (!loaded || !chartGoal) {
    return <div className="h-72 animate-pulse rounded-2xl bg-muted" />
  }

  const { goal, datapoints, contributions, impact } = loaded

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={goal.personal ? 'Personal goal' : 'Organization goal'}
        icon={Target}
        title={goal.name}
        description={`${fmtValue(goal.targetValue, goal.unit)} by ${new Date(goal.targetDate).toLocaleDateString()}`}
        actions={
          <>
            <RiskBadge riskLevel={goal.riskLevel} />
            <Badge variant="outline">{goal.kind.toUpperCase()}</Badge>
            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Pencil className="mr-1.5 h-4 w-4" /> Edit
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Edit goal</DialogTitle></DialogHeader>
                <label className="space-y-1.5 text-sm">
                  <span>Name</span>
                  <Input
                    value={edit.name}
                    onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Target value</span>
                  <Input
                    type="number"
                    step="any"
                    value={edit.targetValue}
                    onChange={(event) =>
                      setEdit({ ...edit, targetValue: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Target date</span>
                  <Input
                    type="date"
                    value={edit.targetDate}
                    onChange={(event) =>
                      setEdit({ ...edit, targetDate: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Recurrence</span>
                  <Select
                    value={edit.recurrence ?? 'none'}
                    onValueChange={(value) =>
                      setEdit({
                        ...edit,
                        recurrence:
                          value === 'none'
                            ? null
                            : (value as Exclude<GoalSummary['recurrence'], null>),
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">One-time</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                {goal.recurrence && (
                  <p className="text-xs text-muted-foreground">
                    Target edits apply to the current window only; future windows copy
                    the target active when they open.
                  </p>
                )}
                <DialogFooter><Button onClick={saveEdit}>Save</Button></DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Archive className="mr-1.5 h-4 w-4" /> Archive
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Archive this goal?</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Its datapoints and attribution remain stored, but it leaves active goal
                  surfaces.
                </p>
                <DialogFooter>
                  <Button variant="destructive" onClick={archive}>Archive</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {goal.recurrence && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Goal period history">
          {[...goal.periods].reverse().map((period) => (
            <span
              key={period.periodEnd}
              title={`${fmtValue(period.finalValue, goal.unit)} final vs ${fmtValue(period.targetValue, goal.unit)} target`}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                period.outcome === 'achieved'
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              }`}
            >
              {periodLabel(
                new Date(period.periodEnd),
                goal.recurrence as Exclude<GoalSummary['recurrence'], null>,
              )}{' '}
              {period.outcome === 'achieved' ? '✓' : '✗'}
            </span>
          ))}
          <span className="rounded-full border border-horizon-500/30 bg-horizon-500/10 px-3 py-1 text-xs font-medium text-horizon-600">
            Current
          </span>
        </div>
      )}

      <Card className="p-5">
        <div className="mb-3">
          <h2 className="font-semibold">Trend and pace</h2>
          <p className="text-xs text-muted-foreground">
            Solid is actual, dashed is target pace, dotted is projection.
          </p>
        </div>
        <GoalTrendChart
          goal={chartGoal}
          points={datapoints}
          markers={contributions.map((contribution) => ({
            at: contribution.createdAt,
            label: `AI showed up here · ${contribution.name}`,
          }))}
        />
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold">Impact on this goal</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ImpactFigure tier="Measured" value={String(impact.measured.runsCompleted)} label="completed actions" />
          <ImpactFigure tier="Estimated" value={`${impact.estimated.hoursSaved.toFixed(1)}h`} label="manual time saved" />
          <ImpactFigure tier="Estimated" value={`$${Math.round(impact.estimated.laborValueUsd).toLocaleString()}`} label="labor value created" />
          <ImpactFigure tier="Estimated" value={impact.estimated.roiMultiple === null ? '—' : `${impact.estimated.roiMultiple.toFixed(1)}×`} label="ROI on AI cost" />
        </div>
        {impact.measured.runsCompleted > 0 && (
          <p className="mt-4 text-sm text-muted-foreground">
            {formatDuration(
              impact.measured.aiRunSecondsTotal / impact.measured.runsCompleted,
            )}{' '}
            measured AI time vs ~
            {Math.round(
              (impact.estimated.hoursSaved * 60) / impact.measured.runsCompleted,
            )}{' '}
            min manual estimate per run.
          </p>
        )}
        {impact.correlated.paceDeltaPct !== null && (
          // Signed: negative means pace SLOWED after linking — reporting that
          // as an improvement would falsify the proof layer's honesty rule.
          <p
            className={`mt-4 text-sm font-medium ${impact.correlated.paceDeltaPct >= 0 ? 'text-success' : 'text-warning'}`}
          >
            {impact.correlated.paceDeltaPct >= 0
              ? `Closing the gap ${impact.correlated.paceDeltaPct.toFixed(0)}% faster since AI started helping.`
              : `Pace is ${Math.abs(impact.correlated.paceDeltaPct).toFixed(0)}% slower since automations were linked — worth a look.`}
            <span className="ml-2 text-xs font-normal uppercase tracking-wide text-muted-foreground">
              correlation
            </span>
          </p>
        )}
      </Card>

      <ContributionPanel goalId={goalId} contributions={contributions} onChanged={load} />

      {goal.benchmark && (
        <Card className="border-muted bg-muted/30 p-5">
          <h2 className="font-semibold">How teams like yours do</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {goal.benchmark.achievedRate}% of {goal.benchmark.orgCount} orgs tracking{' '}
            {goal.kind.toUpperCase()} targets hit their last period.
            {goal.benchmark.topSeeds[0]
              ? ` Most-adopted play: ${goal.benchmark.topSeeds[0].name}.`
              : ''}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Anonymous, cross-workspace counts · no goal values or workspace names shared
          </p>
        </Card>
      )}

      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Metric history</h2>
            <p className="text-sm text-muted-foreground">
              {goal.metric?.source ?? 'manual'} · {goal.metric?.metricKey}
            </p>
          </div>
          <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1.5 h-4 w-4" /> Record value
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Record a metric value</DialogTitle></DialogHeader>
              <label className="space-y-1.5 text-sm">
                <span>Value</span>
                <Input
                  type="number"
                  step="any"
                  value={record.value}
                  onChange={(event) => setRecord({ ...record, value: event.target.value })}
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span>Date (optional)</span>
                <Input
                  type="date"
                  value={record.capturedAt}
                  onChange={(event) =>
                    setRecord({ ...record, capturedAt: event.target.value })
                  }
                />
              </label>
              <DialogFooter>
                <Button
                  onClick={recordValue}
                  disabled={!Number.isFinite(Number(record.value)) || record.value === ''}
                >
                  Record value
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        {goal.metric?.lastError && (
          <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Metric source needs attention</p>
              <p>{goal.metric.lastError}</p>
              <Button variant="link" className="h-auto p-0 text-warning" asChild>
                <Link href="/integrations">Reconnect source</Link>
              </Button>
            </div>
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Origin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {datapoints.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-sm text-muted-foreground">
                  No readings yet — record one or wait for the next sync.
                </TableCell>
              </TableRow>
            ) : (
              [...datapoints].reverse().map((point) => (
                <TableRow key={point.id}>
                  <TableCell>{new Date(point.capturedAt).toLocaleDateString()}</TableCell>
                  <TableCell className="font-mono">{fmtValue(point.value, goal.unit)}</TableCell>
                  <TableCell><Badge variant="outline">{point.origin}</Badge></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {!goal.personal && goal.children.length > 0 && (
        <Card className="space-y-3 p-5">
          <h2 className="font-semibold">Supporting personal goals</h2>
          {goal.children.map((child, index) => (
            <div
              key={child.id ?? `private-${index}`}
              className="flex items-center justify-between gap-3 rounded-xl border p-3"
            >
              <span className="text-sm font-medium">{child.name}</span>
              <RiskBadge riskLevel={child.riskLevel} />
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`
}

function ImpactFigure({
  tier,
  value,
  label,
}: {
  tier: string
  value: string
  label: string
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{tier}</p>
      <p className="font-mono text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
