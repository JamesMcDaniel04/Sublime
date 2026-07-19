/**
 * Deterministic behavior-pattern miner (spec §3). Counts and evidence are
 * computed facts from the ledger — the LLM never asserts a statistic. Input
 * events must be sorted ascending by occurredAt.
 */
import { cosineSimilarity } from '@/lib/rag/embeddings'
import type { PersistedUserEvent } from './index-user-event'

export type LedgerEvent = Pick<PersistedUserEvent, 'id' | 'userId' | 'kind' | 'resourceType' | 'resourceId' | 'context' | 'occurredAt'>

export interface PatternCandidate {
  slug: string
  kind: 'sequence' | 'temporal' | 'friction' | 'intent' | 'tool_correlation' | 'capability_gap' | 'peer_practice' | 'archetype_gap'
  summary: string
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  evidenceEventIds: string[]
}

const SEQUENCE_WINDOW_MS = 60 * 60 * 1000
const FRICTION_WINDOW_MS = 60 * 60 * 1000
export const INTENT_SIMILARITY_THRESHOLD = 0.8

const resourceKey = (e: LedgerEvent) => (e.resourceType && e.resourceId ? `${e.resourceType}:${e.resourceId}` : e.kind)
const eventName = (e: LedgerEvent): string => {
  const ctx = e.context
  const name = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx as { name?: unknown }).name : null
  return typeof name === 'string' && name ? `"${name}"` : (e.resourceId ?? '')
}
const dateOf = (d: Date) => d.toISOString().slice(0, 10)

type Acc = { count: number; first: Date; last: Date; evidence: string[]; summary: string }
const bump = (map: Map<string, Acc>, key: string, when: Date, evidence: string[], summary: string) => {
  const acc = map.get(key)
  if (acc) {
    acc.count += 1
    acc.last = when > acc.last ? when : acc.last
    acc.first = when < acc.first ? when : acc.first
    acc.evidence.push(...evidence)
  } else {
    map.set(key, { count: 1, first: when, last: when, evidence: [...evidence], summary })
  }
}

export function mineUserPatternCandidates(events: LedgerEvent[]): PatternCandidate[] {
  const sequences = new Map<string, Acc>()
  const temporal = new Map<string, Acc>()
  const temporalDates = new Map<string, Set<string>>()
  const friction = new Map<string, Acc>()

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    // sequence: adjacent pair with the NEXT event when close in time and on a different resource
    const next = events[i + 1]
    if (next && next.occurredAt.getTime() - event.occurredAt.getTime() <= SEQUENCE_WINDOW_MS && resourceKey(next) !== resourceKey(event)) {
      const slug = `seq:${event.kind}:${resourceKey(event)}>>${next.kind}:${resourceKey(next)}`
      bump(sequences, slug, next.occurredAt, [event.id, next.id],
        `Does ${event.kind} on ${eventName(event)} then ${next.kind} on ${eventName(next)} shortly after`)
      const acc = sequences.get(slug)
      if (acc && event.occurredAt < acc.first) acc.first = event.occurredAt
    }

    // temporal: same (kind, resource) on the same UTC weekday, distinct dates only
    const weekday = event.occurredAt.getUTCDay()
    const tKey = `routine:${event.kind}:${resourceKey(event)}:${weekday}`
    const dates = temporalDates.get(tKey) ?? new Set<string>()
    if (!dates.has(dateOf(event.occurredAt))) {
      dates.add(dateOf(event.occurredAt))
      temporalDates.set(tKey, dates)
      bump(temporal, tKey, event.occurredAt, [event.id],
        `Does ${event.kind} on ${eventName(event)} on the same weekday (UTC day ${weekday})`)
    }

    // friction: >=3 manual runs of the same agent inside a rolling window
    if (event.kind === 'agent_run_manual' && event.resourceId) {
      const windowIds = [event.id]
      for (let j = i + 1; j < events.length; j++) {
        const later = events[j]
        if (later.occurredAt.getTime() - event.occurredAt.getTime() > FRICTION_WINDOW_MS) break
        if (later.kind === 'agent_run_manual' && later.resourceId === event.resourceId) windowIds.push(later.id)
      }
      if (windowIds.length >= 3) {
        const slug = `friction:agent:${event.resourceId}`
        const existing = friction.get(slug)
        // count distinct bursts: only start a new burst if this event isn't already evidence
        if (!existing || !existing.evidence.includes(event.id)) {
          bump(friction, slug, event.occurredAt, windowIds,
            `Repeatedly re-runs agent ${eventName(event)} in short bursts (possible friction)`)
        }
      }
    }
  }

  const finish = (map: Map<string, Acc>, kind: PatternCandidate['kind']): PatternCandidate[] =>
    [...map.entries()].map(([slug, acc]) => ({
      slug, kind, summary: acc.summary,
      occurrenceCount: acc.count,
      firstSeenAt: acc.first, lastSeenAt: acc.last,
      evidenceEventIds: [...new Set(acc.evidence)],
    }))

  return [...finish(sequences, 'sequence'), ...finish(temporal, 'temporal'), ...finish(friction, 'friction')]
}

/** Greedy single-pass clustering of prompt texts; >=3 similar asks = a theme. */
export async function mineIntentClusters(
  prompts: Array<{ eventId: string; text: string; occurredAt: Date }>,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<PatternCandidate[]> {
  if (prompts.length < 3) return []
  const vectors = await embed(prompts.map((p) => p.text))
  const clusters: Array<{ members: number[] }> = []
  for (let i = 0; i < prompts.length; i++) {
    const vec = vectors[i]
    if (!vec || vec.length === 0) continue
    const home = clusters.find((c) => cosineSimilarity(vectors[c.members[0]], vec) >= INTENT_SIMILARITY_THRESHOLD)
    if (home) home.members.push(i)
    else clusters.push({ members: [i] })
  }
  return clusters
    .filter((c) => c.members.length >= 3)
    .map((c) => {
      const members = c.members.map((i) => prompts[i])
      const shortest = members.reduce((a, b) => (a.text.length <= b.text.length ? a : b))
      const times = members.map((m) => m.occurredAt.getTime())
      return {
        slug: `intent:${members[0].eventId}`,
        kind: 'intent' as const,
        summary: `Recurring assistant request: ${shortest.text.slice(0, 140)}`,
        occurrenceCount: members.length,
        firstSeenAt: new Date(Math.min(...times)),
        lastSeenAt: new Date(Math.max(...times)),
        evidenceEventIds: members.map((m) => m.eventId),
      }
    })
}
