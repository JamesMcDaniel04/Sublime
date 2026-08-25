/**
 * Assembles measured statistics into ComputedBaseline records.
 *
 * Confidence is the PRODUCT of two independent shortfalls — too few events, or
 * too little history — because either alone invalidates the figure. An org with
 * 200 events across three days has a burst, not a cadence; an org with a full
 * quarter of history and four events has noise. Multiplying means a process
 * must clear both bars, where averaging would let a strong volume paper over
 * absent history.
 */
import { groupByProcess, volumeStats } from './aggregate'
import { medianCycleTimeHours, reworkRate } from './transitions'
import type { BaselineEvent, ComputedBaseline } from './types'

/** Below this, a suggestion must be labeled a benchmark, never "measured". */
export const MIN_MEASURED_CONFIDENCE = 0.4

/** Volume at which the count stops limiting confidence. */
const VOLUME_SATURATION = 30
/** Days of history at which coverage stops limiting confidence. */
const WINDOW_SATURATION = 30

export function confidenceOf(input: { volume: number; windowDays: number }): number {
  const volumeFactor = Math.min(1, Math.max(0, input.volume) / VOLUME_SATURATION)
  const coverageFactor = Math.min(1, Math.max(0, input.windowDays) / WINDOW_SATURATION)
  return volumeFactor * coverageFactor
}

/** One process's events → one baseline. Null on an empty group. */
export function computeBaseline(events: BaselineEvent[], windowDays: number): ComputedBaseline | null {
  const first = events[0]
  if (!first) return null
  const stats = volumeStats(events)
  return {
    source: first.source,
    action: first.action,
    entityType: first.entityType,
    volume: stats.volume,
    windowDays,
    periodDays: stats.periodDays,
    distinctActors: stats.distinctActors,
    medianCycleTimeHours: medianCycleTimeHours(events),
    reworkRate: reworkRate(events),
    confidence: confidenceOf({ volume: stats.volume, windowDays }),
  }
}

/** Every process in the feed, most trustworthy first. */
export function computeBaselines(events: BaselineEvent[], windowDays: number): ComputedBaseline[] {
  const baselines: ComputedBaseline[] = []
  for (const group of groupByProcess(events).values()) {
    const baseline = computeBaseline(group, windowDays)
    if (baseline) baselines.push(baseline)
  }
  return baselines.sort((a, b) => b.confidence - a.confidence)
}
