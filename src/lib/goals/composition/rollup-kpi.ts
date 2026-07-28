/**
 * KPI composition: the only kind whose shape the user declares, because 'kpi'
 * absorbed cost trees (former savings), demand funnels (former lead_gen) and
 * arbitrary custom metrics.
 *
 * Shape-irrelevant derived collections are `null` rather than `[]`: an empty
 * array reads as "computed, found none", which is a different claim from
 * "does not apply to this shape".
 */
export type KpiShape = 'funnel' | 'ratio' | 'weighted_sum'

export type KpiConfig = {
  stages?: number
  weights?: Record<string, number>
}

export type KpiRollup = {
  derived: number | null
  present: string[]
  missing: string[]
  stageConversions: Array<{ from: string; to: string; rate: number | null }> | null
  driverShares: Array<{ slot: string; share: number | null }> | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function kpiRequiredSlots(shape: KpiShape, config: KpiConfig): string[] {
  if (shape === 'funnel') {
    // A one-stage funnel is not a funnel; two is the floor.
    const stages = Math.max(2, config.stages ?? 2)
    return Array.from({ length: stages }, (_, index) => `stage:${index + 1}`)
  }
  if (shape === 'ratio') return ['numerator', 'denominator']
  return Object.keys(config.weights ?? {})
}

export function rollupKpi(
  shape: KpiShape,
  components: Map<string, number>,
  config: KpiConfig,
): KpiRollup {
  const required = kpiRequiredSlots(shape, config)
  const present = required.filter((slot) => components.has(slot))
  const missing = required.filter((slot) => !components.has(slot))
  const incomplete = missing.length > 0

  if (shape === 'funnel') {
    // Conversions survive an incomplete funnel: any adjacent pair that IS
    // bound is still a real measurement worth showing.
    const stageConversions = required.slice(0, -1).map((from, index) => {
      const to = required[index + 1]
      const upstream = components.get(from)
      const downstream = components.get(to)
      return {
        from,
        to,
        rate:
          upstream === undefined || downstream === undefined
            ? null
            : ratio(downstream, upstream),
      }
    })
    return {
      derived: incomplete ? null : (components.get(required.at(-1)!) ?? null),
      present,
      missing,
      stageConversions,
      driverShares: null,
    }
  }

  if (shape === 'ratio') {
    return {
      derived: incomplete
        ? null
        : ratio(components.get('numerator')!, components.get('denominator')!),
      present,
      missing,
      stageConversions: null,
      driverShares: null,
    }
  }

  const weights = config.weights ?? {}
  const weighted = required.map((slot) => ({
    slot,
    value: (components.get(slot) ?? 0) * (weights[slot] ?? 0),
  }))
  const total = weighted.reduce((sum, entry) => sum + entry.value, 0)
  return {
    derived: incomplete ? null : total,
    present,
    missing,
    stageConversions: null,
    driverShares: weighted.map((entry) => ({
      slot: entry.slot,
      share: ratio(entry.value, total),
    })),
  }
}
