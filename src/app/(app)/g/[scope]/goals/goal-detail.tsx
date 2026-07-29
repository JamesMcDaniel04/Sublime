'use client'

import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Pencil, RefreshCw, Target } from 'lucide-react'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
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
import { RecoveryPlanStrip } from '@/components/goals/recovery-plan-strip'
import { CompositionStrip } from '@/components/goals/composition-strip'
import { CompositionEditDialog } from '@/components/goals/composition-edit'
import type { MetricSourceOption } from '@/lib/metrics/available-sources'
import { AgentBundleCard } from '@/components/goals/agent-bundle-card'
import { WorkQueue } from '@/components/goals/workroom/work-queue'
import { connectedSlugSet } from '@/lib/templates/relevance'
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
import { invalidateCachedJson, useCachedJson } from '@/lib/client/use-cached-json'

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

/**
 * One goal, in full. Rendered by the goals surface when a goal lens is active —
 * /g/<goalId>/goals — rather than by its own /goals/[id] route, because a goal's
 * detail page IS the goals surface seen through that goal.
 */
export function GoalDetail({ goalId }: { goalId: string }) {
  const router = useScopedRouter()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Which tools this workspace can actually run. A failed probe yields [], so
  // every agent renders blocked-with-a-connect-link rather than hiding the card.
  const integrationsQuery = useCachedJson<{
    success?: boolean
    tools?: Parameters<typeof connectedSlugSet>[0]
  }>('/api/integrations/available')
  const connectedIntegrations = useMemo(
    () =>
      Array.from(
        connectedSlugSet(
          integrationsQuery.data?.success ? (integrationsQuery.data.tools ?? []) : [],
        ),
      ),
    [integrationsQuery.data],
  )
  // Metric sources for the driver editor. A failed probe yields [], which
  // renders the binding control with manual entry only rather than hiding it.
  const sourcesQuery = useCachedJson<{ sources?: MetricSourceOption[] }>(
    '/api/goals/metrics/sources',
  )
  const metricSources = useMemo(
    () => sourcesQuery.data?.sources ?? [],
    [sourcesQuery.data],
  )
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
    // The dashboard caches /api/goals and /api/goals/impact for 60s — a name,
    // target, or recurrence change should be reflected there right away.
    invalidateCachedJson('/api/goals')
    invalidateCachedJson('/api/goals/impact')
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
    // Archiving removes the goal from the active set the dashboard reads.
    invalidateCachedJson('/api/goals')
    invalidateCachedJson('/api/goals/impact')
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
            <CompositionEditDialog
              goal={goal}
              sources={metricSources}
              onSaved={load}
            />
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

      <CompositionStrip state={goal.compositionState} />

      {goal.recoveryPlan && (
        <RecoveryPlanStrip goalId={goalId} plan={goal.recoveryPlan} onChanged={load} />
      )}

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

      {/* Order is deliberate: the work first, the agents that produce it
          directly beneath (so the empty state's "deploy an agent below" is
          literally true), and the number last as evidence. */}
      <WorkQueue goalId={goalId} />

      <AgentBundleCard
        goalId={goalId}
        templateKey={goal.templateKey ?? null}
        kind={goal.kind}
        source={goal.metric?.source ?? null}
        recurrence={goal.recurrence ?? null}
        deployedSeedKeys={contributions
          .map((contribution) => contribution.seedKey)
          .filter((seedKey): seedKey is string => Boolean(seedKey))}
        connectedIntegrations={connectedIntegrations}
        onChanged={load}
      />

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
