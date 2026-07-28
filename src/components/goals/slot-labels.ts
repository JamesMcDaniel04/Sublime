/**
 * Human copy for composition slots. Its own module (like source-labels) so
 * both the binding fields and the composition strip can import it without a
 * cycle — composition-fields imports MetricBindingFields, so the labels cannot
 * live there.
 */
import { ARR_OPTIONAL_SLOTS, ARR_REQUIRED_SLOTS } from '@/lib/goals/composition/rollup-arr'
import { QUOTA_GATE_SLOTS } from '@/lib/goals/composition/rollup-quota'
import { kpiRequiredSlots, type KpiShape } from '@/lib/goals/composition/rollup-kpi'
import type { GoalKind } from '@/lib/goals/kind-migration'

export const SLOT_LABELS: Record<string, string> = {
  new_arr: 'New ARR',
  expansion_arr: 'Expansion ARR',
  contraction_arr: 'Contraction ARR',
  churned_arr: 'Churned ARR',
  customers_start: 'Customers at period start',
  customers_churned: 'Customers churned',
  pipeline_coverage: 'Pipeline coverage ratio',
  win_rate: 'Win rate',
  avg_deal_size: 'Average deal size',
  sales_cycle_days: 'Sales cycle (days)',
  numerator: 'Numerator',
  denominator: 'Denominator',
}

/** One line saying what the driver is for, shown under its label. */
export const SLOT_HINTS: Record<string, string> = {
  new_arr: 'Recurring revenue from customers who were not paying last period.',
  expansion_arr: 'Additional recurring revenue from existing customers.',
  contraction_arr: 'Recurring revenue lost to downgrades, not cancellations.',
  churned_arr: 'Recurring revenue lost to cancellations.',
  customers_start: 'Enables logo churn alongside revenue churn.',
  customers_churned: 'Enables logo churn alongside revenue churn.',
  pipeline_coverage: 'Open pipeline divided by the quota still to close.',
  win_rate: 'Share of qualified opportunities that close won.',
  avg_deal_size: 'Mean closed-won amount.',
  sales_cycle_days: 'Mean days from qualified to closed.',
}

export const slotLabel = (slot: string): string => {
  const known = SLOT_LABELS[slot]
  if (known) return known
  // Driver slots are user-named, so their label is the name they were slugged
  // from — 'driver:data-dog' reads as 'Data dog', not as a raw key.
  if (slot.startsWith('driver:')) {
    const name = slot.slice('driver:'.length).replace(/-/g, ' ')
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  // Funnel stages are positional: 'stage:2' reads as 'Stage 2'.
  if (slot.startsWith('stage:')) return `Stage ${slot.slice('stage:'.length)}`
  return slot
}

export function slotsForKind(
  kind: GoalKind,
  shape?: KpiShape,
  stages?: number,
  weights?: Record<string, number>,
): Array<{ slot: string; required: boolean }> {
  if (kind === 'arr') {
    return [
      ...ARR_REQUIRED_SLOTS.map((slot) => ({ slot, required: true })),
      ...ARR_OPTIONAL_SLOTS.map((slot) => ({ slot, required: false })),
    ]
  }
  if (kind === 'quota') {
    // Quota's rollup sums child goals, so no component is required — these are
    // leading indicators that gate risk when bound.
    return QUOTA_GATE_SLOTS.map((slot) => ({ slot, required: false }))
  }
  // KPI has no shape until the user declares one, and nothing to offer until then.
  if (!shape) return []
  return kpiRequiredSlots(shape, { stages, weights }).map((slot) => ({
    slot,
    required: true,
  }))
}
