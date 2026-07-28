'use client'

/**
 * Per-slot component binding. A component is the same source-binding control
 * the wizard already uses for primary and supporting metrics, rendered once per
 * slot in the kind's vocabulary — so every connector, config validator and
 * connect-dialog behaviour comes along for free.
 *
 * Required slots are marked but never blocking: a goal binds what it can and
 * the composition strip says what is still missing. Blocking creation until
 * four sources are wired would kill the wizard.
 */
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MetricBindingFields, type MetricBinding } from './metric-binding-fields'
import { SLOT_HINTS, slotLabel, slotsForKind } from './slot-labels'
import type { MetricSourceOption } from '@/lib/metrics/available-sources'
import type { KpiShape } from '@/lib/goals/composition/rollup-kpi'
import type { GoalKind } from '@/lib/goals/kind-migration'

export function CompositionFields({
  kind,
  shape,
  stages,
  unit,
  bindings,
  sources,
  onChange,
}: {
  kind: GoalKind
  shape?: KpiShape
  stages?: number
  unit: MetricBinding['unit']
  bindings: MetricBinding[]
  sources: MetricSourceOption[]
  onChange: (next: MetricBinding[]) => void
}) {
  const slots = slotsForKind(kind, shape, stages)
  if (slots.length === 0) return null

  const bindingFor = (slot: string) =>
    bindings.find((binding) => binding.slot === slot) ?? null

  const upsert = (slot: string, next: MetricBinding | null) => {
    const rest = bindings.filter((binding) => binding.slot !== slot)
    onChange(next ? [...rest, next] : rest)
  }

  const boundCount = slots.filter((entry) => bindingFor(entry.slot)).length
  const requiredCount = slots.filter((entry) => entry.required).length

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-semibold">What makes up this number</h3>
        <p className="text-sm text-muted-foreground">
          {requiredCount > 0
            ? 'Bind each driver to a source and this goal can check that its parts add up to the headline. Until every required driver is bound, the goal is held at "at risk" — it will say so and why.'
            : 'Optional leading indicators. Pipeline coverage below 3× holds the goal at "at risk" no matter what the headline says.'}
        </p>
        {boundCount > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {boundCount} of {slots.length} bound
            {requiredCount > 0 && ` · ${requiredCount} required`}
          </p>
        )}
      </div>
      {slots.map(({ slot, required }) => {
        const binding = bindingFor(slot)
        return (
          <div key={slot} className="rounded-xl border p-4">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {slotLabel(slot)}
                  {required && (
                    <span className="ml-1 text-destructive" aria-label="required">
                      *
                    </span>
                  )}
                </p>
                {SLOT_HINTS[slot] && (
                  <p className="text-xs text-muted-foreground">{SLOT_HINTS[slot]}</p>
                )}
              </div>
              {binding ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${slotLabel(slot)}`}
                  onClick={() => upsert(slot, null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    upsert(slot, {
                      label: slotLabel(slot),
                      role: 'component',
                      slot,
                      source: 'manual',
                      metricKey: 'manual.value',
                      unit,
                      connectionRef: null,
                      config: {},
                    })
                  }
                >
                  <Plus className="mr-1.5 h-4 w-4" /> Bind
                </Button>
              )}
            </div>
            {binding && (
              <MetricBindingFields
                binding={binding}
                sources={sources}
                onChange={(next) =>
                  upsert(slot, { ...next, slot, role: 'component' })
                }
              />
            )}
          </div>
        )
      })}
    </section>
  )
}
