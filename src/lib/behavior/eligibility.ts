/**
 * THE eligibility gate (spec §3). Every consumer of behavior patterns —
 * synthesis, assistant context, copilot grounding, per-agent proposals —
 * goes through isPatternEligible/listEligiblePatterns. No other module may
 * implement pattern-eligibility logic. This is the choke point that keeps
 * the platform non-prescriptive by construction: no evidence, no suggestion.
 */
import { prisma } from '@/lib/prisma'

export const MIN_OCCURRENCES = 3
export const MIN_SPAN_DAYS = 7
export const LEARNING_PERIOD_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type GateablePattern = {
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  status: string
}

export function isPatternEligible(
  pattern: GateablePattern,
  userFirstEventAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (pattern.status !== 'open') return false
  if (pattern.occurrenceCount < MIN_OCCURRENCES) return false
  if (pattern.lastSeenAt.getTime() - pattern.firstSeenAt.getTime() < MIN_SPAN_DAYS * DAY_MS) return false
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
    return patterns
      .filter((p) => isPatternEligible(p, firstEvent?.occurredAt ?? null))
      .map((p) => ({
        slug: p.slug, kind: p.kind, summary: p.summary,
        occurrenceCount: p.occurrenceCount, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt,
        evidence: Array.isArray(p.evidence) ? (p.evidence as string[]) : [],
      }))
  } catch {
    return []
  }
}
