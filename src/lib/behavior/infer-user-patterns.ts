/**
 * Daily per-user pattern inference (spec §3). Deterministic mining over the
 * user's ledger + optional intent clustering over their assistant prompts.
 * Dismissal suppression: a candidate matching a dismissed pattern's slug, or
 * embedding-similar (>= MEMORY_SIMILARITY_THRESHOLD) to a dismissed summary,
 * is dropped before it can be written. Never throws.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts, embeddingsConfigured, cosineSimilarity } from '@/lib/rag/embeddings'
import { MEMORY_SIMILARITY_THRESHOLD } from '@/lib/memory/agent-memory'
import { mineUserPatternCandidates, mineIntentClusters, type PatternCandidate } from './mine-patterns'
import { writeUserInference } from './user-insights'

const WINDOW_DAYS = 90
const MAX_EVENTS = 500
const MIN_EVENTS = 10

export type InferOverrides = {
  db?: typeof prisma
  embed?: (texts: string[]) => Promise<number[][]>
  now?: () => Date
}

export async function inferUserBehaviorPatterns(
  organizationId: string,
  userId: string,
  overrides: InferOverrides = {},
): Promise<{ patterns: number } | { skipped: string }> {
  const db = overrides.db ?? prisma
  try {
    const now = overrides.now ? overrides.now() : new Date()
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const events = await db.userEvent.findMany({
      where: { organizationId, userId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EVENTS,
    })
    if (events.length < MIN_EVENTS) return { skipped: 'too-few-events' }

    let candidates: PatternCandidate[] = mineUserPatternCandidates(events)

    // Intent clustering over assistant prompts (needs message text by reference).
    const embed = overrides.embed ?? (embeddingsConfigured() ? (texts: string[]) => embedTexts(texts, { inputType: 'document' }) : null)
    if (embed) {
      const promptEvents = events.filter((e) => e.kind === 'assistant_prompt' && e.resourceId)
      if (promptEvents.length >= 3) {
        const messages = await db.assistantChatMessage.findMany({
          where: { id: { in: promptEvents.map((e) => e.resourceId as string) } },
          select: { id: true, content: true },
        })
        const textById = new Map(messages.map((m) => [m.id, m.content]))
        const prompts = promptEvents
          .map((e) => ({ eventId: e.id, text: textById.get(e.resourceId as string) ?? '', occurredAt: e.occurredAt }))
          .filter((p) => p.text.trim().length > 0)
        candidates = [...candidates, ...(await mineIntentClusters(prompts, embed))]
      }
    }
    if (candidates.length === 0) return { skipped: 'no-candidates' }

    // Dismissal suppression: exact slug + embedding similarity to dismissed summaries.
    const dismissed = await db.userPattern.findMany({
      where: { organizationId, userId, status: 'dismissed' },
      select: { slug: true, summary: true },
    })
    const dismissedSlugs = new Set(dismissed.map((d) => d.slug))
    candidates = candidates.filter((c) => !dismissedSlugs.has(c.slug))
    if (embed && dismissed.length > 0 && candidates.length > 0) {
      const vectors = await embed([...dismissed.map((d) => d.summary), ...candidates.map((c) => c.summary)])
      const dismissedVecs = vectors.slice(0, dismissed.length)
      candidates = candidates.filter((_, i) => {
        const vec = vectors[dismissed.length + i]
        if (!vec || vec.length === 0) return true
        return !dismissedVecs.some((dv) => dv.length > 0 && cosineSimilarity(dv, vec) >= MEMORY_SIMILARITY_THRESHOLD)
      })
    }

    let written = 0
    for (const candidate of candidates) {
      await db.userPattern.upsert({
        where: { userId_slug: { userId, slug: candidate.slug } },
        create: {
          organizationId, userId, slug: candidate.slug, kind: candidate.kind,
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
        // Recompute stats from the sliding window; status is preserved so a
        // dismissed row (raced past the filter) can never be resurrected.
        update: {
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
      })
      const ok = await writeUserInference({
        organizationId, userId, slug: candidate.slug,
        text: candidate.summary, evidenceEventIds: candidate.evidenceEventIds,
      })
      if (ok) written += 1
    }
    return { patterns: written }
  } catch (error) {
    apiLogger.warn('behavior.inferUserBehaviorPatterns failed', {
      organizationId, userId, error: error instanceof Error ? error.message : String(error),
    })
    return { skipped: 'error' }
  }
}
