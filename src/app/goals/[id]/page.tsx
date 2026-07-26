'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Archive, Pencil, RefreshCw, Target } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import type { Contribution } from '@/components/goals/contribution-panel'
import { fmtValue } from '@/components/goals/chart-math'
import { RiskBadge } from '@/components/goals/goal-viz'
import { DashboardEditDialog } from '@/components/goals/dashboard-edit'
import {
  GoalDashboard,
} from '@/components/goals/widgets/goal-dashboard'
import type { ImpactTiers } from '@/components/goals/impact-strip'
import {
  defaultLayoutForGoal,
  parseDashboardLayout,
} from '@/lib/goals/dashboard'
import {
  GOAL_KIND_LABELS,
  type GoalDetail,
  type GoalSummary,
} from '@/lib/types'

const SOFT_SOURCES = new Set([
  'manual',
  'url',
  'slack_assisted',
  'gmail_assisted',
])

type Loaded = {
  goal: GoalDetail
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
  const [edit, setEdit] = useState({
    name: '',
    targetValue: '',
    targetDate: '',
    recurrence: null as GoalSummary['recurrence'],
  })

  const load = useCallback(async () => {
    try {
      setError(null)
      const [goalResponse, contributionsResponse] = await Promise.all([
        fetch(`/api/goals/${goalId}`, { cache: 'no-store' }),
        fetch(`/api/goals/${goalId}/contributions`, {
          cache: 'no-store',
        }),
      ])
      const [goalBody, contributionsBody] = await Promise.all([
        goalResponse.json(),
        contributionsResponse.json(),
      ])
      if (!goalResponse.ok || !contributionsResponse.ok) {
        throw new Error(
          goalBody.error ||
            contributionsBody.error ||
            'Could not load goal.',
        )
      }
      setLoaded({
        goal: goalBody.goal,
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
      setError(
        cause instanceof Error ? cause.message : 'Could not load goal.',
      )
    }
  }, [goalId])

  useEffect(() => {
    void load()
  }, [load])

  const saveEdit = async () => {
    const response = await fetch(`/api/goals/${goalId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: edit.name,
        targetValue: Number(edit.targetValue),
        targetDate: new Date(
          `${edit.targetDate}T23:59:59`,
        ).toISOString(),
        recurrence: edit.recurrence,
      }),
    })
    const body = await response.json()
    if (!response.ok) {
      toast.error(body.error || 'Could not update goal.')
      return
    }
    await load()
    setEditOpen(false)
    toast.success('Goal updated.')
  }

  const archive = async () => {
    const response = await fetch(`/api/goals/${goalId}`, {
      method: 'DELETE',
    })
    const body = await response.json()
    if (!response.ok) {
      toast.error(body.error || 'Could not archive goal.')
      return
    }
    toast.success('Goal archived.')
    router.push('/goals')
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
  if (!loaded) {
    return <div className="h-72 animate-pulse rounded-2xl bg-muted" />
  }

  const { goal, contributions, impact } = loaded
  const layout =
    parseDashboardLayout(goal.dashboardLayout) ?? defaultLayoutForGoal()

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
            <Badge variant="outline">
              {GOAL_KIND_LABELS[goal.kind]}
            </Badge>
            <DashboardEditDialog goal={goal} onSaved={load} />
            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Pencil className="mr-1.5 h-4 w-4" /> Edit
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Edit goal</DialogTitle>
                </DialogHeader>
                <label className="space-y-1.5 text-sm">
                  <span>Name</span>
                  <Input
                    value={edit.name}
                    onChange={(event) =>
                      setEdit({ ...edit, name: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Target value</span>
                  <Input
                    type="number"
                    step="any"
                    value={edit.targetValue}
                    onChange={(event) =>
                      setEdit({
                        ...edit,
                        targetValue: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Target date</span>
                  <Input
                    type="date"
                    value={edit.targetDate}
                    onChange={(event) =>
                      setEdit({
                        ...edit,
                        targetDate: event.target.value,
                      })
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
                            : (value as Exclude<
                                GoalSummary['recurrence'],
                                null
                              >),
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
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
                    Target edits apply to the current window only; future
                    windows copy the target active when they open.
                  </p>
                )}
                <DialogFooter>
                  <Button onClick={saveEdit}>Save</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Archive className="mr-1.5 h-4 w-4" /> Archive
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Archive this goal?</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Its datapoints and attribution remain stored, but it leaves
                  active goal surfaces.
                </p>
                <DialogFooter>
                  <Button variant="destructive" onClick={archive}>
                    Archive
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {goal.metric && SOFT_SOURCES.has(goal.metric.source) && (
        <p className="rounded-xl border border-dashed bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
          This goal is tracked{' '}
          {goal.metric.source === 'manual'
            ? 'manually'
            : 'from an assisted source'}
          .{' '}
          <Link
            href="/integrations"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Connect a source of truth
          </Link>{' '}
          (Stripe, your CRM, or SQL) for exact, automatic tracking.
        </p>
      )}

      <GoalDashboard
        layout={layout}
        data={{
          goal,
          metrics: goal.metrics,
          contributions,
          impact,
          onReload: load,
        }}
      />
    </div>
  )
}
