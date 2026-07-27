'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Link2, Target } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { GOAL_KIND_UNITS, type GoalSummary } from '@/lib/types'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'
import { NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'
import type { DashboardLayout } from '@/lib/goals/dashboard'
import { fmtValue } from '@/components/goals/chart-math'
import {
  SOURCE_HINTS,
  SOURCE_LABELS,
} from '@/components/goals/source-labels'
import { SourceLogo } from '@/components/goals/source-logo'
import { sourceIsAvailable } from '@/lib/metrics/source-options'
import { invalidateCachedJson } from '@/lib/client/use-cached-json'

type Step = 1 | 2 | 3
type GoalKind = GoalSummary['kind']
type GoalUnit = GoalSummary['unit']
type GoalRecurrence = GoalSummary['recurrence']
type Source = {
  source: string
  group: 'start_now' | 'source_of_truth'
  available?: boolean
  metrics: Array<{ key: string; label: string; unit: GoalUnit }>
  connections: Array<{ ref: string; label: string }>
}

const KINDS: Array<{ value: GoalKind; label: string }> = [
  { value: 'arr', label: 'ARR' },
  { value: 'mrr', label: 'MRR' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'quota', label: 'Sales quota' },
  { value: 'savings', label: 'Savings' },
  { value: 'lead_gen', label: 'Lead generation' },
  { value: 'custom_kpi', label: 'Custom KPI' },
]

const tomorrow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

const defaultRecurrence = (kind: GoalKind): GoalRecurrence => {
  if (kind === 'quota') return 'quarterly'
  if (kind === 'mrr' || kind === 'lead_gen') return 'monthly'
  return null
}

export default function NewGoalPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)
  const [sources, setSources] = useState<Source[]>([])
  const [orgGoals, setOrgGoals] = useState<GoalSummary[]>([])
  const [loadingSources, setLoadingSources] = useState(true)
  const [creating, setCreating] = useState(false)
  const [preview, setPreview] = useState<
    | { status: 'idle' | 'loading' }
    | { status: 'success'; value: number; asOf: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' })
  const [state, setState] = useState({
    name: '',
    kind: 'arr' as GoalKind,
    direction: 'increase' as 'increase' | 'decrease',
    unit: 'usd' as GoalUnit,
    targetValue: '',
    targetDate: '',
    recurrence: null as GoalRecurrence,
    personal: false,
    parentGoalId: '',
    source: '',
    metricKey: '',
    connectionRef: '',
    spreadsheetId: '',
    range: '',
    query: '',
    channel: '',
    gmailQuery: '',
    urlValue: '',
    jsonPath: '',
    metricHint: '',
    startValue: '',
  })
  const [csvIntent, setCsvIntent] = useState(false)
  // Set when a template is applied — the layout the user previewed in the
  // template modal, sent verbatim so the created goal's dashboard matches.
  const [templateLayout, setTemplateLayout] = useState<DashboardLayout | null>(null)

  // Template prefill (?template=<key>): window.location instead of
  // useSearchParams so the page needs no Suspense boundary at build time.
  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get('template')
    const entry = key ? goalTemplateByKey(key) : null
    if (entry) {
      setState((current) => ({
        ...current,
        name: entry.name,
        kind: entry.kind,
        direction: entry.direction,
        unit: entry.unit,
        recurrence: entry.recurrence,
        personal: entry.scope === 'personal',
      }))
      setTemplateLayout(entry.layout)
      toast.info(
        `Template applied — set your target${entry.scope === 'personal' ? '' : ' for the org'} and pick a source.`,
      )
      return
    }
    const stored = sessionStorage.getItem('goals:copilot-prefill')
    if (stored) {
      sessionStorage.removeItem('goals:copilot-prefill')
      try {
        const prefill = JSON.parse(stored)
        setState((current) => ({ ...current, ...prefill }))
        toast.info(
          'Copilot draft applied — finish the remaining steps.',
        )
      } catch {
        // Stale/corrupt prefill: start clean.
      }
    }
  }, [])

  useEffect(() => {
    Promise.all([
      fetch('/api/goals/metrics/sources', { cache: 'no-store' }).then((response) =>
        response.json(),
      ),
      fetch('/api/goals', { cache: 'no-store' }).then((response) => response.json()),
    ])
      .then(([sourceBody, goalBody]) => {
        setSources(sourceBody.sources ?? [])
        setOrgGoals((goalBody.goals ?? []).filter((goal: GoalSummary) => !goal.personal))
      })
      .catch(() => toast.error('Could not load metric sources.'))
      .finally(() => setLoadingSources(false))
  }, [])

  const selectedSource = sources.find((source) => source.source === state.source)
  const config = useMemo(
    () =>
      state.source === 'google_sheets'
        ? { spreadsheetId: state.spreadsheetId, range: state.range }
        : state.source === 'postgres'
          ? { query: state.query }
          : state.source === 'url'
            ? { url: state.urlValue, ...(state.jsonPath.trim() ? { jsonPath: state.jsonPath } : {}) }
            : state.source === 'slack_assisted'
              ? { channel: state.channel, ...(state.metricHint.trim() ? { metricHint: state.metricHint } : {}) }
              : state.source === 'gmail_assisted'
                ? { query: state.gmailQuery, ...(state.metricHint.trim() ? { metricHint: state.metricHint } : {}) }
                : {},
    [state.channel, state.gmailQuery, state.jsonPath, state.metricHint, state.query, state.range, state.source, state.spreadsheetId, state.urlValue],
  )

  const chooseSource = (source: Source) => {
    const selectable = sourceIsAvailable(source)
    if (!selectable) return
    const firstMetric = source.metrics[0]
    // A metric reports in its own unit. If that contradicts the unit the
    // target was entered under, silently reinterpreting the number would lie
    // (0.12 "percent" is not 0.12 USD) — clear the target and say so.
    const unitChanged =
      source.source !== 'postgres' &&
      firstMetric !== undefined &&
      firstMetric.unit !== state.unit
    setCsvIntent(false)
    setState((current) => ({
      ...current,
      source: source.source,
      metricKey: firstMetric?.key ?? (source.source === 'manual' ? 'manual.value' : ''),
      connectionRef: source.connections.length === 1 ? source.connections[0].ref : '',
      ...(firstMetric && source.source !== 'postgres' ? { unit: firstMetric.unit } : {}),
      ...(unitChanged ? { targetValue: '' } : {}),
    }))
    if (unitChanged) {
      toast.info(
        `This metric reports in ${firstMetric.unit === 'usd' ? 'USD' : firstMetric.unit} — re-enter your target in step 1.`,
      )
    }
    setPreview({ status: 'idle' })
  }

  const validateTarget = () => {
    if (!state.name.trim()) return 'Name the goal.'
    if (!Number.isFinite(Number(state.targetValue)) || state.targetValue === '') {
      return 'Enter a target value.'
    }
    if (!state.targetDate || new Date(state.targetDate).getTime() <= Date.now()) {
      return 'Choose a future target date.'
    }
    return null
  }

  const nextFromTarget = () => {
    const error = validateTarget()
    if (error) return toast.error(error)
    setStep(2)
  }

  const nextFromSource = () => {
    if (!selectedSource) return toast.error('Choose a metric source.')
    const needsConnection = !NO_CONNECTION_SOURCES.has(state.source)
    if (needsConnection && !state.connectionRef) {
      return toast.error('Choose a connected account.')
    }
    if (!state.metricKey) return toast.error('Choose a metric.')
    if (
      state.source === 'google_sheets' &&
      (!state.spreadsheetId.trim() || !state.range.trim())
    ) {
      return toast.error('Enter a spreadsheet id and A1 range.')
    }
    if (state.source === 'postgres' && !state.query.trim()) {
      return toast.error('Enter a single SELECT query.')
    }
    if (state.source === 'url' && !state.urlValue.trim()) {
      return toast.error('Enter the URL that reports this number.')
    }
    if (state.source === 'slack_assisted' && !state.channel.trim()) {
      return toast.error('Enter the Slack channel that reports this number.')
    }
    if (state.source === 'gmail_assisted' && !state.gmailQuery.trim()) {
      return toast.error('Enter the Gmail search that finds the report emails.')
    }
    setPreview({ status: 'idle' })
    setStep(3)
  }

  const runPreview = useCallback(async () => {
    if (state.source === 'manual') {
      setPreview({ status: 'idle' })
      return
    }
    setPreview({ status: 'loading' })
    try {
      const response = await fetch('/api/goals/metrics/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: state.source,
          metricKey: state.metricKey,
          connectionRef: state.connectionRef,
          config,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Preview failed.')
      setState((current) => ({ ...current, startValue: String(body.value) }))
      setPreview({ status: 'success', value: body.value, asOf: body.asOf })
    } catch (error) {
      setPreview({
        status: 'error',
        message: error instanceof Error ? error.message : 'Preview failed.',
      })
    }
  }, [config, state.connectionRef, state.metricKey, state.source])

  useEffect(() => {
    if (step === 3 && state.source !== 'manual' && preview.status === 'idle') {
      void runPreview()
    }
  }, [preview.status, runPreview, state.source, step])

  const create = async () => {
    // Number('') is 0 — an empty baseline must not silently become one.
    if (state.startValue.trim() === '') return toast.error('Enter a baseline value.')
    const startValue = Number(state.startValue)
    const targetValue = Number(state.targetValue)
    if (!Number.isFinite(startValue)) return toast.error('Enter a valid baseline.')
    if (startValue === targetValue) return toast.error('Target must differ from the baseline.')
    setCreating(true)
    try {
      const response = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: state.name.trim(),
          kind: state.kind,
          direction: state.direction,
          unit: state.unit,
          startValue,
          targetValue,
          targetDate: new Date(`${state.targetDate}T23:59:59`).toISOString(),
          recurrence: state.recurrence,
          personal: state.personal,
          ...(state.personal && state.parentGoalId
            ? { parentGoalId: state.parentGoalId }
            : {}),
          ...(templateLayout ? { dashboardLayout: templateLayout } : {}),
          metric: {
            source: state.source,
            metricKey: state.metricKey,
            connectionRef: NO_CONNECTION_SOURCES.has(state.source)
              ? null
              : state.connectionRef,
            config,
          },
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not create goal.')
      // The dashboard caches /api/goals and /api/goals/impact for 60s —
      // invalidate so a freshly created goal shows up immediately instead of
      // leaving the no-goals hero stuck for up to a minute.
      invalidateCachedJson('/api/goals')
      invalidateCachedJson('/api/goals/impact')
      if (csvIntent && body.goal?.id) {
        toast.success('Goal created — import your CSV history next.')
        router.push(`/goals/${body.goal.id}?import=1`)
        return
      }
      toast.success(
        state.source === 'manual'
          ? 'Goal created.'
          : 'Goal created — first sync lands within the hour.',
      )
      // Land on the goal itself, not the list: an org-scoped goal renders in
      // a section above "My goals", so /goals could look like nothing was
      // created at all.
      router.push(`/goals/${body.goal.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create goal.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow={`Step ${step} of 3`}
        icon={Target}
        title="Create a goal"
        description="Choose the target, connect its source of truth, and verify the baseline."
      />

      <div className="flex items-center gap-2" aria-label={`Step ${step} of 3`}>
        {[1, 2, 3].map((number) => (
          <div
            key={number}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              number <= step ? 'bg-horizon-500' : 'bg-muted',
            )}
          />
        ))}
      </div>

      {step === 1 && (
        <Card className="space-y-5 p-6">
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Goal name</span>
            <Input
              value={state.name}
              onChange={(event) =>
                setState((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Reach $2M ARR"
              maxLength={120}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Goal kind</span>
              <Select
                value={state.kind}
                onValueChange={(value) =>
                  setState((current) => ({
                    ...current,
                    kind: value as GoalKind,
                    direction: value === 'savings' ? 'decrease' : 'increase',
                    // The kind implies the unit; custom_kpi keeps the picker.
                    unit: GOAL_KIND_UNITS[value as GoalKind] ?? current.unit,
                    recurrence: defaultRecurrence(value as GoalKind),
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>
                      {kind.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {state.kind === 'custom_kpi' ? (
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Unit</span>
                <Select
                  value={state.unit}
                  onValueChange={(value) =>
                    setState((current) => ({ ...current, unit: value as GoalUnit }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="usd">USD</SelectItem>
                    <SelectItem value="count">Count</SelectItem>
                    <SelectItem value="percent">Percent (0–1)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <div className="space-y-1.5 text-sm">
                <span className="font-medium">Unit</span>
                <p className="rounded-lg border bg-muted px-3 py-2 text-muted-foreground">
                  {state.unit === 'usd' ? 'USD' : state.unit === 'count' ? 'Count' : 'Percent'}
                  <span className="ml-1 text-xs">· set by goal kind</span>
                </p>
              </div>
            )}
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Target value</span>
              <Input
                type="number"
                step="any"
                value={state.targetValue}
                onChange={(event) =>
                  setState((current) => ({ ...current, targetValue: event.target.value }))
                }
                placeholder={state.unit === 'percent' ? '0.12' : '2000000'}
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Target date</span>
              <Input
                type="date"
                min={tomorrow()}
                value={state.targetDate}
                onChange={(event) =>
                  setState((current) => ({ ...current, targetDate: event.target.value }))
                }
              />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Recurrence</span>
              <Select
                value={state.recurrence ?? 'none'}
                onValueChange={(value) =>
                  setState((current) => ({
                    ...current,
                    recurrence:
                      value === 'none' ? null : (value as Exclude<GoalRecurrence, null>),
                  }))
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
          </div>
          {state.kind === 'savings' && (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              Savings goals count down: progress increases as the tracked value falls.
            </p>
          )}
          <div className="flex items-center justify-between rounded-xl border p-4">
            <div>
              <p className="text-sm font-medium">
                {state.personal ? 'Personal goal' : 'Organization goal'}
              </p>
              <p className="text-xs text-muted-foreground">
                {state.personal ? 'Visible only to you.' : 'Visible across your workspace.'}
              </p>
            </div>
            <Switch
              checked={state.personal}
              onCheckedChange={(personal) =>
                setState((current) => ({
                  ...current,
                  personal,
                  parentGoalId: personal ? current.parentGoalId : '',
                }))
              }
              aria-label="Personal goal"
            />
          </div>
          {state.personal && orgGoals.length > 0 && (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Supports org goal (optional)</span>
              <Select
                value={state.parentGoalId || 'none'}
                onValueChange={(value) =>
                  setState((current) => ({
                    ...current,
                    parentGoalId: value === 'none' ? '' : value,
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {orgGoals.map((goal) => (
                    <SelectItem key={goal.id} value={goal.id}>{goal.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card className="space-y-4 p-6">
          <div>
            <h2 className="font-semibold">Metric source</h2>
            <p className="text-sm text-muted-foreground">
              Pick the system that owns this number. Sources without a connection stay
              visible so setup is obvious.
            </p>
          </div>
          {loadingSources ? (
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : (
            <div className="space-y-5">
              {(
                [
                  ['start_now', 'Start tracking now', 'These work with what you already have — no new integrations required.'],
                  ['source_of_truth', 'Stronger sources of truth', 'Connect for exact, automatic tracking — the upgrade path when you are ready.'],
                ] as const
              ).map(([group, heading, blurb]) => (
                <div key={group} className="space-y-3">
                  <div>
                    <p className="text-sm font-semibold">{heading}</p>
                    <p className="text-xs text-muted-foreground">{blurb}</p>
                  </div>
                  <div className="space-y-3" role="radiogroup" aria-label={heading}>
                    {sources
                      .filter((source) => source.group === group)
                      .map((source) => {
                        const available =
                          source.available === true ||
                          source.source === 'manual' ||
                          source.connections.length > 0
                        const selected = !csvIntent && state.source === source.source
                        return (
                          <div
                            key={source.source}
                            className={cn(
                              'rounded-xl border p-4 transition-colors',
                              available
                                ? 'cursor-pointer hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                                : 'bg-muted/40',
                              selected && 'border-horizon-500 bg-horizon-500/5',
                            )}
                            onClick={() => available && chooseSource(source)}
                            onKeyDown={(event) => {
                              if (available && (event.key === 'Enter' || event.key === ' ')) {
                                event.preventDefault()
                                chooseSource(source)
                              }
                            }}
                            role={available ? 'radio' : undefined}
                            aria-checked={available ? selected : undefined}
                            aria-disabled={available ? undefined : true}
                            tabIndex={available ? 0 : undefined}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <SourceLogo source={source.source} className="mt-0.5" />
                                <div className="min-w-0">
                                  <p className="font-medium">
                                    {SOURCE_LABELS[source.source] ?? source.source}
                                  </p>
                                  {SOURCE_HINTS[source.source] && (
                                    <p className="text-xs text-muted-foreground">
                                      {SOURCE_HINTS[source.source]}
                                    </p>
                                  )}
                                  {!available && (
                                    <p className="text-xs text-muted-foreground">
                                      {source.source === 'slack_assisted'
                                        ? 'Slack is not connected for this workspace yet.'
                                        : 'Connect an account before selecting this source.'}
                                    </p>
                                  )}
                                </div>
                              </div>
                              {selected && <Check className="h-4 w-4 text-success" />}
                              {!available && source.source !== 'slack_assisted' && (
                                <Button variant="outline" size="sm" asChild>
                                  <Link
                                    href={
                                      source.source === 'stripe' || source.source === 'postgres'
                                        ? '/integrations?tab=credentials'
                                        : '/integrations'
                                    }
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                                    Connect
                                  </Link>
                                </Button>
                              )}
                            </div>
                            {selected && source.connections.length > 1 && (
                              <div className="mt-3" onClick={(event) => event.stopPropagation()}>
                                <Select
                                  value={state.connectionRef}
                                  onValueChange={(connectionRef) =>
                                    setState((current) => ({ ...current, connectionRef }))
                                  }
                                >
                                  <SelectTrigger><SelectValue placeholder="Choose account" /></SelectTrigger>
                                  <SelectContent>
                                    {source.connections.map((connection) => (
                                      <SelectItem key={connection.ref} value={connection.ref}>
                                        {connection.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    {group === 'start_now' && (
                      <div
                        className={cn(
                          'cursor-pointer rounded-xl border p-4 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          csvIntent && 'border-horizon-500 bg-horizon-500/5',
                        )}
                        role="radio"
                        aria-checked={csvIntent}
                        tabIndex={0}
                        onClick={() => {
                          const manual = sources.find((candidate) => candidate.source === 'manual')
                          if (manual) chooseSource(manual)
                          setCsvIntent(true)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            const manual = sources.find((candidate) => candidate.source === 'manual')
                            if (manual) chooseSource(manual)
                            setCsvIntent(true)
                          }
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">Import history from a CSV</p>
                            <p className="text-xs text-muted-foreground">
                              date,value rows — we create the goal and take you straight to the import.
                            </p>
                          </div>
                          {csvIntent && <Check className="h-4 w-4 text-success" />}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {selectedSource && selectedSource.metrics.length > 1 && (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Metric</span>
              <Select
                value={state.metricKey}
                onValueChange={(metricKey) =>
                  setState((current) => ({ ...current, metricKey }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {selectedSource.metrics.map((metric) => (
                    <SelectItem key={metric.key} value={metric.key}>{metric.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {state.source === 'google_sheets' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Spreadsheet id</span>
                <Input
                  value={state.spreadsheetId}
                  onChange={(event) =>
                    setState((current) => ({
                      ...current,
                      spreadsheetId: event.target.value,
                    }))
                  }
                  placeholder="1AbC…"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">A1 range</span>
                <Input
                  value={state.range}
                  onChange={(event) =>
                    setState((current) => ({ ...current, range: event.target.value }))
                  }
                  placeholder="KPIs!B2"
                />
              </label>
            </div>
          )}
          {state.source === 'postgres' && (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Read-only SQL query</span>
              <Textarea
                value={state.query}
                onChange={(event) =>
                  setState((current) => ({ ...current, query: event.target.value }))
                }
                className="min-h-36 font-mono text-sm"
                placeholder="SELECT count(*) FROM completed_orders"
                maxLength={10_000}
              />
              <span className="text-xs text-muted-foreground">
                Single SELECT returning one numeric value. Store the connection string as a
                Bearer credential token.
              </span>
            </label>
          )}
          {state.source === 'url' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">URL</span>
                <Input
                  value={state.urlValue}
                  onChange={(event) =>
                    setState((current) => ({ ...current, urlValue: event.target.value }))
                  }
                  placeholder="https://status.example.com/mrr.json"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">JSON path (optional)</span>
                <Input
                  value={state.jsonPath}
                  onChange={(event) =>
                    setState((current) => ({ ...current, jsonPath: event.target.value }))
                  }
                  placeholder="data.mrr.current"
                />
              </label>
            </div>
          )}
          {state.source === 'slack_assisted' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Slack channel</span>
                <Input
                  value={state.channel}
                  onChange={(event) =>
                    setState((current) => ({ ...current, channel: event.target.value }))
                  }
                  placeholder="#revenue"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">What number should we read? (optional)</span>
                <Input
                  value={state.metricHint}
                  onChange={(event) =>
                    setState((current) => ({ ...current, metricHint: event.target.value }))
                  }
                  placeholder="weekly MRR"
                />
              </label>
            </div>
          )}
          {state.source === 'gmail_assisted' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Gmail search</span>
                <Input
                  value={state.gmailQuery}
                  onChange={(event) =>
                    setState((current) => ({ ...current, gmailQuery: event.target.value }))
                  }
                  placeholder="subject:(weekly revenue report)"
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">What number should we read? (optional)</span>
                <Input
                  value={state.metricHint}
                  onChange={(event) =>
                    setState((current) => ({ ...current, metricHint: event.target.value }))
                  }
                  placeholder="closed-won revenue"
                />
              </label>
            </div>
          )}
        </Card>
      )}

      {step === 3 && (
        <Card className="space-y-5 p-6">
          <div>
            <h2 className="font-semibold">Verify the baseline</h2>
            <p className="text-sm text-muted-foreground">
              This becomes day one of the goal’s proof trail.
            </p>
          </div>
          {state.source === 'manual' ? (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Current value</span>
              <Input
                type="number"
                step="any"
                value={state.startValue}
                onChange={(event) =>
                  setState((current) => ({ ...current, startValue: event.target.value }))
                }
              />
            </label>
          ) : preview.status === 'loading' ? (
            <Skeleton className="h-24" />
          ) : preview.status === 'error' ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="text-sm text-destructive">{preview.message}</p>
              <Button className="mt-3" variant="outline" onClick={() => void runPreview()}>
                Retry
              </Button>
            </div>
          ) : preview.status === 'success' ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-success/30 bg-success/5 p-4">
                <p className="text-xs font-medium text-success">Connection verified</p>
                <p className="mt-1 font-mono text-2xl font-bold">
                  {fmtValue(preview.value, state.unit)}
                </p>
                <p className="text-xs text-muted-foreground">
                  Current source value · as of {new Date(preview.asOf).toLocaleString()}
                </p>
              </div>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Baseline override (optional)</span>
                <Input
                  type="number"
                  step="any"
                  value={state.startValue}
                  onChange={(event) =>
                    setState((current) => ({ ...current, startValue: event.target.value }))
                  }
                />
              </label>
            </div>
          ) : null}
        </Card>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          onClick={() => {
            if (step === 1) router.push('/goals')
            else setStep((step - 1) as Step)
          }}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {step === 1 ? 'Cancel' : 'Back'}
        </Button>
        {step === 1 && (
          <Button onClick={nextFromTarget}>
            Source <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
        {step === 2 && (
          <Button onClick={nextFromSource}>
            Verify <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
        {step === 3 && (
          <Button
            onClick={create}
            disabled={
              creating ||
              state.startValue.trim() === '' ||
              !Number.isFinite(Number(state.startValue)) ||
              (state.source !== 'manual' && preview.status !== 'success')
            }
          >
            {creating ? 'Creating…' : 'Create goal'}
          </Button>
        )}
      </div>
    </div>
  )
}
