/**
 * Duration and rework, derived from state transitions.
 *
 * Both metrics require `previousState`, which is why the adapters were changed
 * to populate it. Where a process has no transitions these return null rather
 * than a zero — "no rework observed" and "rework unmeasurable" are different
 * claims, and only the second is honest about a point-event feed.
 */
import { median } from './aggregate'
import type { BaselineEvent } from './types'

const MS_PER_HOUR = 60 * 60 * 1000

/** The stage/status label inside a state blob, if it has one. Adapters name
 *  this field differently per provider (stage for deals, status for tasks,
 *  state for pull requests), so all three are accepted. */
function stateLabel(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null
  const blob = state as Record<string, unknown>
  for (const field of ['stage', 'status', 'state']) {
    if (typeof blob[field] === 'string') return blob[field] as string
  }
  return null
}

export function hasTransitions(events: BaselineEvent[]): boolean {
  return events.some((event) => event.previousState != null)
}

function byEntity(events: BaselineEvent[]): Map<string, BaselineEvent[]> {
  const groups = new Map<string, BaselineEvent[]>()
  for (const event of events) {
    const bucket = groups.get(event.entityRef)
    if (bucket) bucket.push(event)
    else groups.set(event.entityRef, [event])
  }
  // Sorting per entity is what keeps an out-of-order feed from producing
  // negative gaps and a nonsense median.
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }
  return groups
}

/**
 * Median hours between consecutive transitions on the same entity. Median, not
 * mean: one stalled deal sitting open for a year would otherwise define the
 * org's "typical" cycle time.
 */
export function medianCycleTimeHours(events: BaselineEvent[]): number | null {
  if (!hasTransitions(events)) return null
  const gaps: number[] = []
  for (const bucket of byEntity(events).values()) {
    for (let index = 1; index < bucket.length; index += 1) {
      gaps.push((bucket[index].occurredAt.getTime() - bucket[index - 1].occurredAt.getTime()) / MS_PER_HOUR)
    }
  }
  return median(gaps)
}

/**
 * Fraction of entities that re-enter a state they previously left. Walking each
 * entity in time order, a transition INTO a state already recorded as departed
 * is a backwards step — the signal that a process loops rather than flows.
 */
export function reworkRate(events: BaselineEvent[]): number | null {
  if (!hasTransitions(events)) return null
  let considered = 0
  let reworked = 0

  for (const bucket of byEntity(events).values()) {
    const departed = new Set<string>()
    let counts = false
    let regressed = false
    for (const event of bucket) {
      const from = stateLabel(event.previousState)
      const to = stateLabel(event.newState)
      if (from === null || to === null) continue
      counts = true
      if (departed.has(to)) regressed = true
      departed.add(from)
    }
    if (!counts) continue
    considered += 1
    if (regressed) reworked += 1
  }

  return considered === 0 ? null : reworked / considered
}
