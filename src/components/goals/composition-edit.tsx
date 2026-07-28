'use client'

/**
 * Bind a goal's drivers after it exists (spec 2026-07-28 §6). The wizard covers
 * creation; without this a goal could never gain a composition, and an ARR goal
 * created before composition existed could never be decomposed.
 *
 * Sends the whole set — the composition is only valid as a set, so a partial
 * save could leave the goal permanently gated.
 */
import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CompositionFields } from './composition-fields'
import { KPI_SHAPE_OPTIONS, KpiShapeFields } from './kpi-shape-fields'
import {
  MIN_FUNNEL_STAGES,
  kpiConfigFrom,
  type Driver,
} from './kpi-shape'
import type { MetricBinding } from './metric-binding-fields'
import type { MetricSourceOption } from '@/lib/metrics/available-sources'
import type { KpiShape } from '@/lib/goals/composition/rollup-kpi'
import type { GoalDetail } from '@/lib/types'

/** Rebuild the editor's state from what the goal already has bound. */
function bindingsFromGoal(goal: GoalDetail): MetricBinding[] {
  return goal.metrics
    .filter((series) => series.role === 'component' && series.slot)
    .map((series) => ({
      label: series.label ?? series.slot!,
      role: 'component' as const,
      slot: series.slot!,
      source: series.source,
      metricKey: series.metricKey,
      unit: series.unit,
      connectionRef: null,
      config: {},
    }))
}

/** Recover the declared shape so reopening the dialog shows what was saved. */
function shapeFromGoal(goal: GoalDetail): {
  shape: KpiShape | ''
  stages: number
  drivers: Driver[]
} {
  const composition = goal.composition as
    | { shape?: KpiShape; stages?: number; weights?: Record<string, number> }
    | null
    | undefined
  if (!composition?.shape) {
    return { shape: '', stages: MIN_FUNNEL_STAGES, drivers: [] }
  }
  return {
    shape: composition.shape,
    stages: composition.stages ?? MIN_FUNNEL_STAGES,
    drivers: Object.entries(composition.weights ?? {}).map(([slot, weight]) => ({
      name: slot.replace(/^driver:/, '').replace(/-/g, ' '),
      weight: String(weight),
    })),
  }
}

export function CompositionEditDialog({
  goal,
  sources,
  onSaved,
}: {
  goal: GoalDetail
  sources: MetricSourceOption[]
  onSaved: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bindings, setBindings] = useState<MetricBinding[]>([])
  const [shape, setShape] = useState<KpiShape | ''>('')
  const [stages, setStages] = useState(MIN_FUNNEL_STAGES)
  const [drivers, setDrivers] = useState<Driver[]>([])

  // Reset from the goal whenever the dialog opens, so a cancelled edit never
  // leaks into the next one.
  useEffect(() => {
    if (!open) return
    setBindings(bindingsFromGoal(goal))
    const recovered = shapeFromGoal(goal)
    setShape(recovered.shape)
    setStages(recovered.stages)
    setDrivers(recovered.drivers)
  }, [goal, open])

  const composition =
    bindings.length === 0
      ? null
      : goal.kind === 'kpi'
        ? shape
          ? { kind: 'kpi' as const, shape, ...kpiConfigFrom(shape, stages, drivers) }
          : null
        : { kind: goal.kind }

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch(`/api/goals/${goal.id}/components`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          composition,
          components: bindings.map((binding) => ({
            slot: binding.slot,
            label: binding.label,
            source: binding.source,
            metricKey: binding.metricKey,
            connectionRef: binding.connectionRef,
            unit: binding.unit,
            config: binding.config,
          })),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not save the drivers.')
      await onSaved()
      setOpen(false)
      toast.success('Drivers saved and the goal re-evaluated.')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not save the drivers.',
      )
    } finally {
      setSaving(false)
    }
  }

  const removedCount = bindingsFromGoal(goal).filter(
    (existing) => !bindings.some((binding) => binding.slot === existing.slot),
  ).length

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Layers className="mr-1.5 h-4 w-4" /> Drivers
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What makes up this number</DialogTitle>
        </DialogHeader>
        {goal.kind === 'kpi' && (
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Break this number down?</span>
            <Select
              value={shape || 'none'}
              onValueChange={(value) => {
                setShape(value === 'none' ? '' : (value as KpiShape))
                setBindings([])
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {KPI_SHAPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        {goal.kind === 'kpi' && shape && (
          <KpiShapeFields
            shape={shape}
            stages={stages}
            drivers={drivers}
            onStagesChange={(next) => {
              setStages(next)
              setBindings([])
            }}
            onDriversChange={(next) => {
              setDrivers(next)
              setBindings([])
            }}
          />
        )}
        <CompositionFields
          kind={goal.kind}
          shape={shape || undefined}
          stages={stages}
          weights={
            composition && 'weights' in composition ? composition.weights : undefined
          }
          unit={goal.unit}
          bindings={bindings}
          sources={sources}
          onChange={setBindings}
        />
        {removedCount > 0 && (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
            {removedCount} driver{removedCount > 1 ? 's' : ''} will be unbound.
            Their recorded readings are deleted with them.
          </p>
        )}
        <DialogFooter>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save drivers'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
