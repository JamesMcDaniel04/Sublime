/**
 * THE eligibility gate (spec §3). Every consumer of behavior patterns —
 * synthesis, assistant context, copilot grounding, per-agent proposals —
 * goes through isPatternEligible/listEligiblePatterns. No other module may
 * implement pattern-eligibility logic. This is the choke point that keeps
 * the platform non-prescriptive by construction: no evidence, no suggestion.
 */
import { prisma } from '@/lib/prisma'
import { loadOutcomeKindWeights, KIND_SUPPRESS_WEIGHT } from './outcome-weights'

/** Env override for a learning-window constant: a non-negative integer, else
 *  the default. Lets a new deployment or demo dial the 7-day windows down
 *  (e.g. to 0/1) without a code change — the gate stays the single choke
 *  point, it just reads a tunable threshold. Floors keep values sane. */
function tunable(envVar: string, fallback: number, floor = 0): number {
  const parsed = Number(process.env[envVar])
  return Number.isFinite(parsed) && parsed >= floor ? Math.floor(parsed) : fallback
}

export const MIN_OCCURRENCES = tunable('BEHAVIOR_MIN_OCCURRENCES', 3, 1)
export const MIN_SPAN_DAYS = tunable('BEHAVIOR_MIN_SPAN_DAYS', 7)
export const LEARNING_PERIOD_DAYS = tunable('BEHAVIOR_LEARNING_PERIOD_DAYS', 7)
/** A routine not observed in this long is no longer a routine — without this
 *  bound, a pattern from months ago would ground suggestions forever. */
export const MAX_STALE_DAYS = tunable('BEHAVIOR_MAX_STALE_DAYS', 30, 1)

const DAY_MS = 24 * 60 * 60 * 1000

/** tool_correlation needs more support than the generic gate: 5 sessions. */
export const MIN_CORRELATION_OCCURRENCES = tunable('BEHAVIOR_MIN_CORRELATION_OCCURRENCES', 5, 1)

export type GateablePattern = {
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  status: string
  /** Pattern kind; omitted rows gate as generic behavior patterns. */
  kind?: string
}

export function isPatternEligible(
  pattern: GateablePattern,
  userFirstEventAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (pattern.status !== 'open') return false
  // capability_gap evidence is ABSENCE (a dormant connection, an unused
  // capability) and peer_practice occurrence is TEAMMATE runs (thresholded by
  // its miner) — occurrence/span minimums don't apply to either; staleness and
  // the learning period below still do. lastSeenAt is when mining last
  // observed the condition holding, so an un-re-observed row decays out like
  // any routine.
  const isGap = pattern.kind === 'capability_gap' || pattern.kind === 'peer_practice' || pattern.kind === 'archetype_gap'
  const minOccurrences = pattern.kind === 'tool_correlation' ? MIN_CORRELATION_OCCURRENCES : MIN_OCCURRENCES
  if (!isGap && pattern.occurrenceCount < minOccurrences) return false
  if (!isGap && pattern.lastSeenAt.getTime() - pattern.firstSeenAt.getTime() < MIN_SPAN_DAYS * DAY_MS) return false
  if (now.getTime() - pattern.lastSeenAt.getTime() > MAX_STALE_DAYS * DAY_MS) return false
  if (userFirstEventAt == null) return false
  if (now.getTime() - userFirstEventAt.getTime() < LEARNING_PERIOD_DAYS * DAY_MS) return false
  return true
}

export type EligiblePattern = {
  slug: string
  kind: string
  summary: string
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  evidence: string[]
}

/** Open patterns for this user that pass the gate. Never throws — returns []. */
export async function listEligiblePatterns(
  organizationId: string,
  userId: string,
  db = prisma,
): Promise<EligiblePattern[]> {
  try {
    const [patterns, firstEvent] = await Promise.all([
      db.userPattern.findMany({
        where: { organizationId, userId, status: 'open' },
        orderBy: { occurrenceCount: 'desc' },
        take: 50,
      }),
      db.userEvent.findFirst({
        where: { organizationId, userId },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
    ])
    // Outcome learning (phase 4): a kind whose suggestions this user keeps
    // rejecting is suppressed until the history decays; kinds that led to
    // adopted automations rank first. The loader never throws — a failure
    // degrades to unweighted gating, never an empty list.
    const weights = await loadOutcomeKindWeights(organizationId, userId, db)
    return patterns
      .filter((p) => isPatternEligible(p, firstEvent?.occurredAt ?? null))
      .filter((p) => (weights.get(p.kind) ?? 0) > KIND_SUPPRESS_WEIGHT)
      .sort((a, b) => (weights.get(b.kind) ?? 0) - (weights.get(a.kind) ?? 0) || b.occurrenceCount - a.occurrenceCount)
      .map((p) => ({
        slug: p.slug, kind: p.kind, summary: p.summary,
        occurrenceCount: p.occurrenceCount, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt,
        evidence: Array.isArray(p.evidence) ? (p.evidence as string[]) : [],
      }))
  } catch {
    return []
  }
}
