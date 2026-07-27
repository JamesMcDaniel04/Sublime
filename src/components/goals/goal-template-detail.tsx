'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { GoalDashboard } from '@/components/goals/widgets/goal-dashboard'
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from '@/components/goals/goal-template-accents'
import { SOURCE_HINTS, SOURCE_LABELS } from '@/components/goals/source-labels'
import { buildPreviewDashboardData } from '@/lib/goals/preview-data'
import { resolveLayoutMetricRefs } from '@/lib/goals/dashboard'
import { connectedSourceSet, type MetricSourceOption } from '@/lib/metrics/source-options'
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { GOAL_KIND_LABELS } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Plausible sample targets so the preview shows a believable shape. The
 *  user's real target is always collected in the wizard. */
const SAMPLE_TARGETS: Record<string, { start: number; target: number }> = {
  usd: { start: 250_000, target: 1_000_000 },
  count: { start: 40, target: 160 },
  percent: { start: 62, target: 85 },
}

export function GoalTemplateDetail({
  template,
  sources,
  sourcesFailed,
  onClose,
}: {
  template: GoalTemplate | null
  sources: MetricSourceOption[]
  /** True when /api/goals/metrics/sources failed — render neutral, never block. */
  sourcesFailed: boolean
  onClose: () => void
}) {
  const connected = useMemo(
    () => (sourcesFailed ? new Set<string>() : connectedSourceSet(sources)),
    [sources, sourcesFailed],
  )

  const preview = useMemo(() => {
    if (!template) return null
    const sample = SAMPLE_TARGETS[template.unit] ?? SAMPLE_TARGETS.count
    const { start, target } = sample
    const built = buildPreviewDashboardData({
      name: template.name,
      description: template.description,
      kind: template.kind,
      direction: template.direction,
      unit: template.unit,
      startValue: template.direction === 'decrease' ? target : start,
      targetValue: template.direction === 'decrease' ? start : target,
      targetDate: null,
      recurrence: template.recurrence,
      personal: template.scope === 'personal',
      metrics: [
        {
          label: template.name,
          role: 'primary',
          unit: template.unit,
          source: template.sources[0],
          metricKey: 'preview',
        },
      ],
      seed: template.key,
    })
    return {
      data: built.data,
      layout: resolveLayoutMetricRefs(template.layout, built.metricIds),
    }
  }, [template])

  if (!template || !preview) return null

  const accent = CATEGORY_ACCENTS[template.category]
  const Icon = CATEGORY_ICONS[template.category]
  const recommended = sourcesFailed
    ? null
    : (template.sources.find((source) => connected.has(source)) ?? null)

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', accent.tile)}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-2">
              <DialogTitle className="text-lg leading-snug">{template.name}</DialogTitle>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>
                  {template.category}
                </Badge>
                <Badge variant={template.scope === 'org' ? 'secondary' : 'outline'} className="text-[11px] font-medium">
                  {template.scope === 'org' ? 'Org' : 'Personal'}
                </Badge>
                <Badge variant="outline" className="text-[11px] font-medium">
                  {GOAL_KIND_LABELS[template.kind]}
                </Badge>
                {template.recurrence && (
                  <Badge variant="outline" className="text-[11px] font-medium">↻ {template.recurrence}</Badge>
                )}
              </div>
            </div>
          </div>
          <DialogDescription className="pt-2">{template.description}</DialogDescription>
        </DialogHeader>

        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold">What gets tracked</h3>
          <p className="text-sm text-muted-foreground">{template.tracks}</p>
          <p className="text-sm text-muted-foreground">
            This number should go{' '}
            <strong className="text-foreground">
              {template.direction === 'increase' ? 'up' : 'down'}
            </strong>{' '}
            over time.
          </p>
          <p className="text-xs text-muted-foreground">
            {template.scope === 'org'
              ? 'Creates an organization goal, visible to everyone in your workspace. You can switch it to personal in the next step.'
              : 'Creates a personal goal, visible only to you. You can switch it to an organization goal in the next step.'}
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Reads from</h3>
          <ul className="space-y-1.5">
            {template.sources.map((source) => {
              const isConnected = connected.has(source)
              return (
                <li
                  key={source}
                  data-connected={isConnected}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      {isConnected && <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden />}
                      {SOURCE_LABELS[source] ?? source}
                      {recommended === source && (
                        <Badge variant="secondary" className="text-[10px] font-medium">Recommended</Badge>
                      )}
                    </p>
                    {SOURCE_HINTS[source] && (
                      <p className="text-xs text-muted-foreground">{SOURCE_HINTS[source]}</p>
                    )}
                    {source === 'manual' && (
                      <p className="text-xs text-muted-foreground">
                        Always available — no connection needed.
                      </p>
                    )}
                  </div>
                  {!isConnected && !sourcesFailed && source !== 'manual' && (
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/integrations">Connect</Link>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Dashboard preview</h3>
            <p className="text-xs text-muted-foreground">Sample data — your real numbers replace it.</p>
          </div>
          <ErrorBoundary
            fallback={
              <p className="rounded-lg border border-border/60 p-4 text-sm text-muted-foreground">
                Preview unavailable.
              </p>
            }
          >
            <GoalDashboard layout={preview.layout} data={preview.data} />
          </ErrorBoundary>
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button asChild>
            <Link href={`/goals/new?template=${template.key}`}>Use template</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
