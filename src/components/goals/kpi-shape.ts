/**
 * KPI shape configuration, kept pure so the wizard and the goal-edit dialog
 * build identical composition specs from identical inputs.
 *
 * KPI is the only kind whose shape the user declares, and two of its three
 * shapes need more than a slot list: a funnel needs a stage count, and a
 * weighted sum needs named drivers with weights. Without those, selecting the
 * shape yields nothing to bind.
 */
import type { KpiShape } from '@/lib/goals/composition/rollup-kpi'

export const MIN_FUNNEL_STAGES = 2
export const MAX_FUNNEL_STAGES = 6

export type Driver = { name: string; weight: string }

/**
 * A driver's slot key. Slugged so the slot survives renaming punctuation and
 * stays inside the create route's 64-char bound; a name that slugs to nothing
 * yields null rather than the meaningless slot `driver:`.
 */
export function driverSlot(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug ? `driver:${slug}` : null
}

/** Drivers that are usable AND unique — a duplicate slot is dropped, since the
 *  create route rejects the whole request when two components share a slot. */
export function usableDrivers(drivers: Driver[]): Array<{ slot: string; driver: Driver }> {
  const seen = new Set<string>()
  const usable: Array<{ slot: string; driver: Driver }> = []
  for (const driver of drivers) {
    const slot = driverSlot(driver.name)
    if (!slot || seen.has(slot)) continue
    seen.add(slot)
    usable.push({ slot, driver })
  }
  return usable
}

/** The `stages` / `weights` half of a KPI composition spec. */
export function kpiConfigFrom(
  shape: KpiShape,
  stages: number,
  drivers: Driver[],
): { stages?: number; weights?: Record<string, number> } {
  if (shape === 'funnel') {
    return {
      stages: Math.min(MAX_FUNNEL_STAGES, Math.max(MIN_FUNNEL_STAGES, stages)),
    }
  }
  if (shape === 'weighted_sum') {
    const weights: Record<string, number> = {}
    for (const { slot, driver } of usableDrivers(drivers)) {
      const weight = Number(driver.weight)
      // An unparseable or blank weight means "count it once", not "count it
      // zero" — a silent zero would drop the driver from the sum entirely.
      weights[slot] = Number.isFinite(weight) && weight !== 0 ? weight : 1
    }
    return { weights }
  }
  return {}
}

/** Whether the shape is configured enough to bind anything against. */
export function kpiShapeIsReady(
  shape: KpiShape,
  stages: number,
  drivers: Driver[],
): boolean {
  if (shape === 'ratio') return true
  if (shape === 'funnel') return stages >= MIN_FUNNEL_STAGES
  return usableDrivers(drivers).length > 0
}
