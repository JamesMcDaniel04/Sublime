/**
 * Pure aggregation over activity rows. No DB, no LLM, no estimates — every
 * value here is counted or timed from observed events, which is what lets a
 * downstream ROI figure survive scrutiny.
 */
import type { BaselineEvent, ProcessKey } from './types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function processKeyOf(key: ProcessKey): string {
  return `${key.source}|${key.action}|${key.entityType}`
}

export function groupByProcess(events: BaselineEvent[]): Map<string, BaselineEvent[]> {
  const groups = new Map<string, BaselineEvent[]>()
  for (const event of events) {
    const key = processKeyOf(event)
    const bucket = groups.get(key)
    if (bucket) bucket.push(event)
    else groups.set(key, [event])
  }
  return groups
}

/**
 * periodDays is the MEDIAN gap between consecutive occurrences, not the mean:
 * a single burst of backfilled history, or one long-dormant stretch, would
 * drag a mean far from the org's actual cadence. Fewer than 2 events yields
 * null — one occurrence evidences no rhythm at all.
 */
export function volumeStats(events: BaselineEvent[]): {
  volume: number
  distinctActors: number
  periodDays: number | null
} {
  const volume = events.length
  const distinctActors = new Set(events.map((event) => event.actorRef)).size
  if (volume < 2) return { volume, distinctActors, periodDays: null }

  const times = events.map((event) => event.occurredAt.getTime()).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let index = 1; index < times.length; index += 1) {
    gaps.push((times[index] - times[index - 1]) / MS_PER_DAY)
  }
  return { volume, distinctActors, periodDays: median(gaps) }
}
