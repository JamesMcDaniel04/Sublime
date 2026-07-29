'use client'

import { useEffect, useMemo, useState } from 'react'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { invalidateCachedJson } from '@/lib/client/use-cached-json'
import { GoalDashboard } from '@/components/goals/widgets/goal-dashboard'
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
import {
  MetricBindingFields,
  metricBindingIssue,
  type MetricBinding,
} from '@/components/goals/metric-binding-fields'
import {
  defaultLayoutForGoal,
  resolveLayoutMetricRefs,
} from '@/lib/goals/dashboard'
import type { CopilotDraft } from '@/lib/goals/copilot'
import type { MetricSourceOption } from '@/lib/metrics/source-options'
import { GOAL_KIND_LABELS } from '@/lib/types'

const tomorrow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

export function CopilotPreview({
  draft,
  notes,
  onCancel,
}: {
  draft: CopilotDraft
  notes: string[]
  onCancel: () => void
}) {
  const router = useScopedRouter()
  const [name, setName] = useState(draft.name)
  const [targetValue, setTargetValue] = useState(
    draft.suggestedTarget ? String(draft.suggestedTarget.value) : '',
  )
  const [targetDate, setTargetDate] = useState(
    draft.suggestedTargetDate ?? '',
  )
  const [recurrence, setRecurrence] = useState(draft.recurrence)
  const [personal, setPersonal] = useState(draft.personal)
  const [metrics, setMetrics] = useState<MetricBinding[]>(draft.metrics)
  const [startValue, setStartValue] = useState('')
  const [sources, setSources] = useState<MetricSourceOption[]>([])
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetch('/api/goals/metrics/sources', { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) {
          throw new Error(body.error || 'Could not load metric sources.')
        }
        setSources(body.sources ?? [])
      })
      .catch((error) =>
        toast.error(
          error instanceof Error
            ? error.message
            : 'Could not load metric sources.',
        ),
      )
  }, [])

  const primaryIndex = metrics.findIndex(
    (metric) => metric.role === 'primary',
  )
  const primary = metrics[primaryIndex]
  const primaryKey = primary
    ? JSON.stringify({
        source: primary.source,
        metricKey: primary.metricKey,
        connectionRef: primary.connectionRef,
        config: primary.config,
      })
    : ''

  const updateMetric = (index: number, next: MetricBinding) => {
    setMetrics((current) =>
      current.map((metric, candidate) =>
        candidate === index ? next : metric,
      ),
    )
    if (index === primaryIndex) {
      setVerifiedKey(null)
      if (next.source !== 'manual') setStartValue('')
    }
  }

  const verify = async () => {
    if (!primary) return
    setVerifying(true)
    try {
      const response = await fetch('/api/goals/metrics/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: primary.source,
          metricKey: primary.metricKey,
          connectionRef: primary.connectionRef,
          config: primary.config,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Preview failed.')
      setStartValue(String(body.value))
      setVerifiedKey(primaryKey)
      toast.success('Current value verified.')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Preview failed.',
      )
    } finally {
      setVerifying(false)
    }
  }

  const preview = useMemo(
    () =>
      buildPreviewDashboardData({
        name: name || draft.name,
        description: draft.description,
        kind: draft.kind,
        direction: draft.direction,
        unit: draft.unit,
        startValue: Number(startValue || 0),
        targetValue: Number(targetValue || 0),
        targetDate: targetDate || null,
        recurrence,
        personal,
        metrics: metrics.map((binding) => ({
          label: binding.label,
          role: binding.role,
          unit: binding.unit,
          source: binding.source,
          metricKey: binding.metricKey,
        })),
      }),
    [
      draft.description,
      draft.direction,
      draft.kind,
      draft.name,
      draft.unit,
      metrics,
      name,
      personal,
      recurrence,
      startValue,
      targetDate,
      targetValue,
    ],
  )
  const previewData = preview.data
  const previewLayout = draft.layout
    ? resolveLayoutMetricRefs(draft.layout, preview.metricIds)
    : defaultLayoutForGoal()

  const target = Number(targetValue)
  const start = Number(startValue)
  const primaryReady =
    primary?.source === 'manual' || verifiedKey === primaryKey
  const bindingIssue = metrics
    .map((metric) => metricBindingIssue(metric))
    .find((issue) => issue !== null) ?? null
  const canCreate =
    name.trim().length > 0 &&
    targetValue.trim().length > 0 &&
    Number.isFinite(target) &&
    targetDate >= tomorrow() &&
    startValue.trim().length > 0 &&
    Number.isFinite(start) &&
    start !== target &&
    Boolean(primary) &&
    primaryReady &&
    bindingIssue === null

  const create = async () => {
    if (!canCreate) return
    setCreating(true)
    try {
      const response = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: draft.description ?? undefined,
          kind: draft.kind,
          direction: draft.direction,
          unit: draft.unit,
          startValue: start,
          targetValue: target,
          targetDate: new Date(
            `${targetDate}T23:59:59`,
          ).toISOString(),
          recurrence,
          personal,
          metrics,
          ...(draft.layout
            ? { dashboardLayout: draft.layout }
            : {}),
        }),
      })
      const body = await response.json()
      if (!response.ok) {
        throw new Error(body.error || 'Could not create the dashboard.')
      }
      // The dashboard caches /api/goals and /api/goals/impact for 60s —
      // invalidate so this goal shows up there immediately.
      invalidateCachedJson('/api/goals')
      invalidateCachedJson('/api/goals/impact')
      toast.success('Goal dashboard created.')
      router.push(`/goals/${body.goal.id}`)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not create the dashboard.',
      )
    } finally {
      setCreating(false)
    }
  }

  const openInWizard = () => {
    sessionStorage.setItem(
      'goals:copilot-prefill',
      JSON.stringify({
        name,
        kind: draft.kind,
        direction: draft.direction,
        unit: draft.unit,
        recurrence,
        personal,
      }),
    )
    router.push('/goals/new')
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-5 border-chart-violet/30 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">
            {GOAL_KIND_LABELS[draft.kind]}
          </Badge>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-64 flex-1 text-base font-semibold"
            aria-label="Goal name"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Target value</span>
            <Input
              type="number"
              step="any"
              value={targetValue}
              onChange={(event) => setTargetValue(event.target.value)}
            />
            {draft.suggestedTarget?.rationale && (
              <span className="block text-xs text-muted-foreground">
                {draft.suggestedTarget.rationale}
              </span>
            )}
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Target date</span>
            <Input
              type="date"
              min={tomorrow()}
              value={targetDate}
              onChange={(event) => setTargetDate(event.target.value)}
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Recurrence</span>
            <Select
              value={recurrence ?? 'none'}
              onValueChange={(value) =>
                setRecurrence(
                  value === 'none'
                    ? null
                    : (value as NonNullable<typeof recurrence>),
                )
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
          <label className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
            <span>
              <span className="block font-medium">Personal</span>
              <span className="text-xs text-muted-foreground">
                Private to you
              </span>
            </span>
            <Switch checked={personal} onCheckedChange={setPersonal} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Unit: <span className="font-medium">{draft.unit}</span>
        </p>
      </Card>

      {notes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {notes.map((note) => (
            <span
              key={note}
              className="rounded-full border border-warning/30 bg-warning/5 px-3 py-1 text-xs text-warning"
            >
              {note}
            </span>
          ))}
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Tracked metrics</h2>
          <p className="text-sm text-muted-foreground">
            Confirm where each number comes from.
          </p>
        </div>
        {metrics.map((binding, index) => (
          <Card key={`${binding.role}-${index}`} className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <Input
                value={binding.label}
                onChange={(event) =>
                  updateMetric(index, {
                    ...binding,
                    label: event.target.value,
                  })
                }
                aria-label={`Metric ${index + 1} label`}
              />
              <Badge
                variant={
                  binding.role === 'primary' ? 'default' : 'outline'
                }
              >
                {binding.role}
              </Badge>
            </div>
            <MetricBindingFields
              binding={binding}
              sources={sources}
              onChange={(next) => updateMetric(index, next)}
            />
            {binding.role === 'primary' &&
              (binding.source === 'manual' ? (
                <label className="block max-w-xs space-y-1.5 text-sm">
                  <span className="font-medium">Current value</span>
                  <Input
                    type="number"
                    step="any"
                    value={startValue}
                    onChange={(event) =>
                      setStartValue(event.target.value)
                    }
                  />
                </label>
              ) : (
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={verify}
                    disabled={verifying}
                  >
                    {verifying ? 'Verifying…' : 'Verify current value'}
                  </Button>
                  {verifiedKey === primaryKey && (
                    <span className="text-sm font-medium text-success">
                      Verified: {startValue} {binding.unit}
                    </span>
                  )}
                </div>
              ))}
          </Card>
        ))}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Dashboard preview</h2>
          <p className="text-sm text-muted-foreground">
            Sample curves show the layout; real readings replace them after
            creation.
          </p>
        </div>
        <GoalDashboard layout={previewLayout} data={previewData} />
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {bindingIssue && (
          <p className="mr-auto text-xs text-muted-foreground">{bindingIssue}</p>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Start over
        </Button>
        <Button variant="outline" onClick={openInWizard}>
          Open in wizard
        </Button>
        <Button onClick={create} disabled={!canCreate || creating}>
          {creating ? 'Creating…' : 'Create dashboard'}
        </Button>
      </div>
    </div>
  )
}
