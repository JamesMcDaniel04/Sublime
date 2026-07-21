/**
 * Outcome-learning weights (intelligence phase 4). Deterministic feedback
 * from what HAPPENED to past suggestions into the eligibility gate: a pattern
 * kind whose suggestions a user keeps rejecting stops being ground for new
 * ones until the history ages out; kinds that led to adopted automations rank
 * first. Pure model + a best-effort loader — no LLM, no new tables.
 *
 * Lives in behavior (not intelligence) because eligibility.ts consumes it and
 * intelligence already imports behavior — the dependency must flow this way.
 * suggest-user-workflows.ts re-exports the labeler for its callers.
 */
import { prisma } from '@/lib/prisma'

/**
 * What actually HAPPENED to a past suggestion — feedback richer than
 * accepted/dismissed. An accepted draft flow that was never published within
 * two weeks is a weak signal; one whose draft got deleted is a negative one.
 * Pure so the labeling is testable. (Moved from suggest-user-workflows.)
 */
export type SuggestionFeedbackRow = {
  title: string
  status: string
  kind: string
  flowId: string | null
  updatedAt: Date
}

export const ADOPTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

export function suggestionOutcomeLabel(
  row: SuggestionFeedbackRow,
  flow: { status: string; publishedGraph: unknown } | null,
  now: Date,
): string {
  if (row.status !== 'accepted') return row.status
  if (row.kind !== 'new_flow' || !row.flowId) return 'accepted'
  if (!flow) return 'accepted-then-deleted'
  if (flow.status === 'ACTIVE' || flow.publishedGraph != null) return 'accepted-and-adopted'
  if (now.getTime() - row.updatedAt.getTime() > ADOPTION_WINDOW_MS) return 'accepted-but-never-published'
  return 'accepted'
}

/** Slug prefix → pattern kind; the miners own these prefixes. */
const SLUG_KIND_PREFIXES: Array<[string, string]> = [
  ['seq:', 'sequence'],
  ['routine:', 'temporal'],
  ['friction:', 'friction'],
  ['intent:', 'intent'],
  ['toolcorr:', 'tool_correlation'],
  ['gap:', 'capability_gap'],
  ['peer:', 'peer_practice'],
  ['archetype:', 'archetype_gap'],
  ['commit:', 'commitment'],
]

export function patternKindOfSlug(slug: string): string | null {
  const match = SLUG_KIND_PREFIXES.find(([prefix]) => slug.startsWith(prefix))
  return match ? match[1] : null
}

const OUTCOME_SCORES: Record<string, number> = {
  'accepted-and-adopted': 2,
  accepted: 1,
  'accepted-but-never-published': -1,
  dismissed: -1,
  'accepted-then-deleted': -2,
}

export const scoreOutcome = (outcome: string): number => OUTCOME_SCORES[outcome] ?? 0

/** A kind at/below this cumulative weight is suppressed at the gate. */
export const KIND_SUPPRESS_WEIGHT = -2

/** Only recent, actioned history counts — suppression self-heals by decay. */
export const OUTCOME_WINDOW_DAYS = 90
export const OUTCOME_MAX_SUGGESTIONS = 20

/** Each past suggestion contributes its score once to EACH kind it cited. */
export function computeKindWeights(
  entries: Array<{ sourcePatternSlugs: string[]; outcome: string }>,
): Map<string, number> {
  const weights = new Map<string, number>()
  for (const entry of entries) {
    const score = scoreOutcome(entry.outcome)
    if (score === 0) continue
    const kinds = new Set(entry.sourcePatternSlugs.map(patternKindOfSlug).filter((k): k is string => k != null))
    for (const kind of kinds) weights.set(kind, (weights.get(kind) ?? 0) + score)
  }
  return weights
}

/**
 * Per-user kind weights from their recent suggestion history, adoption-aware
 * (accepted drafts are checked against the live flow). Never throws — any
 * failure means no learning today, never a broken gate.
 */
export async function loadOutcomeKindWeights(
  organizationId: string,
  userId: string,
  db = prisma,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  try {
    const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const rows = await db.userSuggestion.findMany({
      where: { organizationId, userId, status: { in: ['accepted', 'dismissed'] }, updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: OUTCOME_MAX_SUGGESTIONS,
      select: { title: true, status: true, kind: true, flowId: true, updatedAt: true, sourcePatternSlugs: true },
    })
    const acceptedFlowIds = rows
      .filter((row) => row.status === 'accepted' && row.kind === 'new_flow' && row.flowId)
      .map((row) => row.flowId as string)
    const flows = acceptedFlowIds.length
      ? await db.flow.findMany({
          where: { id: { in: acceptedFlowIds }, organizationId },
          select: { id: true, status: true, publishedGraph: true },
        })
      : []
    const flowById = new Map(flows.map((flow) => [flow.id, flow]))
    return computeKindWeights(
      rows.map((row) => ({
        sourcePatternSlugs: Array.isArray(row.sourcePatternSlugs) ? (row.sourcePatternSlugs as string[]) : [],
        outcome: suggestionOutcomeLabel(row, row.flowId ? flowById.get(row.flowId) ?? null : null, now),
      })),
    )
  } catch {
    return new Map()
  }
}
