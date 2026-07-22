import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedQuery, embeddingsConfigured, cosineSimilarity, toSqlVector } from '@/lib/rag/embeddings'
import { keywordScore } from '@/lib/knowledge/retrieve'

export const MEMORY_SIMILARITY_THRESHOLD = 0.86
export const KEYWORD_MATCH_THRESHOLD = 0.6
export const MEMORY_INJECTION_LIMIT = 6
export const AGENT_MEMORY_CAP = 500

export type MemoryKind = 'user_answer' | 'learning' | 'suggestion'
export type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number }

function embeddingOf(value: unknown): number[] | null {
  return Array.isArray(value) ? (value as number[]) : null
}

async function tryEmbed(text: string): Promise<number[] | null> {
  if (!embeddingsConfigured()) return null
  try {
    return await embedQuery(text.slice(0, 4000))
  } catch {
    return null
  }
}

export type MemoryDedupMatch = { status: string; sourceRef: string | null }

/**
 * Pure dedup decision, factored out of saveAgentMemory's nearest-neighbor
 * lookup so the dismiss-durability rule is unit-testable without a
 * pgvector-backed database.
 *
 * `match` is the single nearest open/dismissed row of the same kind (or
 * null if none exists); `similarity` is its cosine similarity (1 - distance)
 * to the memory being saved. Returns:
 * - 'insert': no match, or the match is below MEMORY_SIMILARITY_THRESHOLD,
 *   or (learnings only) the match belongs to a different sourceRef.
 * - 'dedupe': bump the match's timesUsed instead of inserting a new row.
 *   The caller must NOT touch the match's status — a dismissed match stays
 *   dismissed; that durability is the entire point of this function.
 *
 * Suggestions dedupe on kind + status alone (unchanged, pre-existing
 * behavior — suggestions may not carry a sourceRef). Learnings additionally
 * require the match to share the same sourceRef (`<plane>:<connectionRef>`)
 * as the memory being saved, so learnings distilled from different
 * connections never merge into each other even if the text is similar.
 */
export function decideMemoryDedup(params: {
  kind: MemoryKind
  similarity: number
  match: MemoryDedupMatch | null
  requestSourceRef?: string | null
}): 'insert' | 'dedupe' {
  if (!params.match || params.similarity < MEMORY_SIMILARITY_THRESHOLD) return 'insert'
  if (params.kind === 'suggestion') return 'dedupe'
  if (params.kind === 'learning') {
    return params.match.sourceRef === (params.requestSourceRef ?? null) ? 'dedupe' : 'insert'
  }
  return 'insert'
}

/**
 * Persist one agent memory. Suggestions and connection-scan learnings are
 * deduped against open OR dismissed rows of the same kind (>= threshold
 * cosine bumps timesUsed on the survivor instead of inserting); learnings
 * are additionally scoped by sourceRef so learnings from different
 * connections never merge (see decideMemoryDedup). A dismissed match keeps
 * its 'dismissed' status — dismissing a suggestion or learning is durable
 * and must not be undone by a later run re-proposing the same thing.
 * Enforces the per-agent cap by superseding the oldest learnings. Never
 * throws.
 */
export async function saveAgentMemory(params: {
  organizationId: string
  agentId: string
  kind: MemoryKind
  title: string
  content: string
  question?: string
  sourceExecutionId?: string
  /** Stable `<plane>:<connectionRef>` key when this memory was distilled from
   *  a connection scan — powers a precise purge on disconnect. */
  sourceRef?: string
}): Promise<{ id: string; deduped: boolean } | null> {
  try {
    const embedText = params.kind === 'user_answer' ? params.question ?? params.content : `${params.title}\n${params.content}`
    const embedding = await tryEmbed(embedText)

    if ((params.kind === 'suggestion' || params.kind === 'learning') && embedding) {
      // Nearest-neighbor via pgvector: the single closest open/dismissed row
      // of the same kind, compared against the threshold. SET LOCAL scopes
      // the widened search_path to this transaction only (see
      // retrieveKnowledge for the same Supabase extensions-schema note).
      const vectorLiteral = toSqlVector(embedding)
      const nearest = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan keeps recall once the org filter narrows the
        // index's global-nearest candidates (see knowledge/retrieve.ts).
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        if (params.kind === 'suggestion') {
          return tx.$queryRaw<Array<{ id: string; status: string; sourceRef: string | null; distance: number }>>`
            SELECT "id", "status", "sourceRef", ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
            FROM "agent_memories"
            WHERE "organizationId" = ${params.organizationId}::uuid
              AND "agentId" = ${params.agentId}
              AND "kind" = 'suggestion'
              AND "status" IN ('open', 'dismissed')
              AND "embeddingVec" IS NOT NULL
            ORDER BY distance ASC
            LIMIT 1
          `
        }
        // Learnings: additionally scoped by sourceRef so a near-duplicate
        // from a different connection is never treated as a match (see
        // decideMemoryDedup). No sourceRef on this write means there's
        // nothing safe to scope against, so skip the lookup entirely.
        if (!params.sourceRef) return []
        return tx.$queryRaw<Array<{ id: string; status: string; sourceRef: string | null; distance: number }>>`
          SELECT "id", "status", "sourceRef", ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND "agentId" = ${params.agentId}
            AND "kind" = 'learning'
            AND "sourceRef" = ${params.sourceRef}
            AND "status" IN ('open', 'dismissed')
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT 1
        `
      })
      const match = nearest[0]
      const decision = decideMemoryDedup({
        kind: params.kind,
        similarity: match ? 1 - match.distance : -1,
        match: match ? { status: match.status, sourceRef: match.sourceRef } : null,
        requestSourceRef: params.sourceRef ?? null,
      })
      if (decision === 'dedupe' && match) {
        // Do NOT touch status here: a dismissed match must stay dismissed.
        await prisma.agentMemory.update({
          where: { id: match.id, organizationId: params.organizationId },
          data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
        })
        return { id: match.id, deduped: true }
      }
    }

    const created = await prisma.agentMemory.create({
      data: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title.slice(0, 200),
        content: params.content,
        question: params.question,
        embedding: embedding ?? undefined,
        sourceExecutionId: params.sourceExecutionId,
        sourceRef: params.sourceRef,
      },
    })

    if (embedding) {
      const vectorLiteral = toSqlVector(embedding)
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        await tx.$executeRaw`
          UPDATE "agent_memories" SET "embeddingVec" = ${vectorLiteral}::vector(1024)
          WHERE "id" = ${created.id} AND "organizationId" = ${params.organizationId}::uuid
        `
      })
    }

    // Cap: supersede the oldest open learnings beyond the limit.
    const openCount = await prisma.agentMemory.count({
      where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open' },
    })
    if (openCount > AGENT_MEMORY_CAP) {
      const overflow = await prisma.agentMemory.findMany({
        where: { organizationId: params.organizationId, agentId: params.agentId, status: 'open', kind: 'learning' },
        orderBy: { createdAt: 'asc' },
        take: openCount - AGENT_MEMORY_CAP,
        select: { id: true },
      })
      if (overflow.length) {
        await prisma.agentMemory.updateMany({
          where: { id: { in: overflow.map((m) => m.id) }, organizationId: params.organizationId },
          data: { status: 'superseded' },
        })
      }
    }

    void import('@/lib/rag/indexer')
      .then((indexer) => indexer.indexAgentMemory({
        memoryId: created.id,
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: params.kind,
        title: params.title,
        content: params.content,
      }))
      .catch(() => undefined)

    return { id: created.id, deduped: false }
  } catch (error) {
    apiLogger.warn('saveAgentMemory failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Edit a saved memory's user-facing fields and KEEP ITS EMBEDDING IN SYNC.
 * The auto-answer match runs on the embedding of `question ?? content`
 * (mirrored from saveAgentMemory), so editing either must re-embed — otherwise
 * the row would answer future questions from its stale, pre-edit vector.
 * Scoped to (org, agent, id); returns false when the row doesn't match.
 */
export async function updateAgentMemory(params: {
  organizationId: string
  agentId: string
  id: string
  title?: string
  content?: string
  question?: string
}): Promise<boolean> {
  const existing = await prisma.agentMemory.findFirst({
    where: { id: params.id, organizationId: params.organizationId, agentId: params.agentId },
    select: { kind: true, content: true, question: true },
  })
  if (!existing) return false

  const nextContent = params.content ?? existing.content
  const nextQuestion = params.question ?? existing.question ?? undefined
  const embedText = existing.kind === 'user_answer' ? nextQuestion ?? nextContent : `${params.title ?? ''}\n${nextContent}`
  const embedding = await tryEmbed(embedText)

  await prisma.agentMemory.update({
    where: { id: params.id, organizationId: params.organizationId },
    data: {
      ...(params.title !== undefined ? { title: params.title.slice(0, 200) } : {}),
      ...(params.content !== undefined ? { content: params.content } : {}),
      ...(params.question !== undefined ? { question: params.question } : {}),
      ...(embedding ? { embedding } : {}),
    },
  })
  // Keep the pgvector column aligned with the JSON embedding (same write shape
  // saveAgentMemory uses); a failed re-embed leaves the prior vector rather
  // than silently zeroing auto-answer for this row.
  if (embedding) {
    const vectorLiteral = toSqlVector(embedding)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
      await tx.$executeRaw`
        UPDATE "agent_memories" SET "embeddingVec" = ${vectorLiteral}::vector(1024)
        WHERE "id" = ${params.id} AND "organizationId" = ${params.organizationId}::uuid
      `
    }).catch((error) => apiLogger.warn('updateAgentMemory: vector sync failed', { error: error instanceof Error ? error.message : String(error) }))
  }
  return true
}

/**
 * Pure eligibility predicate factored out of retrieveAgentMemory's two query
 * paths (pgvector + keyword fallback). The calling agent's own rows are
 * eligible regardless of kind (pre-existing behavior: an agent's own
 * suggestions may enter its own context). A row that belongs to one of the
 * `extraAgentIds` (e.g. the hidden org-intelligence holder) is eligible ONLY
 * when it is a `learning` — the holder also stores `kind:'suggestion'` rows
 * (from suggest-workflows) that must never leak into another agent's run
 * context.
 */
export function isEligibleMemoryRow(params: {
  rowAgentId: string
  rowKind: string
  callingAgentId: string
  extraAgentIds: string[]
}): boolean {
  if (params.rowAgentId === params.callingAgentId) return true
  return params.rowKind === 'learning' && params.extraAgentIds.includes(params.rowAgentId)
}

/**
 * Top-k open memories for this agent. Ranks in-database by pgvector cosine
 * distance (HNSW index) over ALL of the agent's open memories when
 * embeddings are available, else falls back to keyword overlap over a
 * bounded scan. Never throws.
 */
export async function retrieveAgentMemory(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
  /** Additional agent ids to widen the filter over (e.g. the org-wide
   *  intelligence agent), so shared learnings surface alongside this
   *  agent's own memories. Only their `kind:'learning'` rows are eligible —
   *  see isEligibleMemoryRow. */
  extraAgentIds?: string[]
}): Promise<MemoryHit[]> {
  const k = params.k ?? MEMORY_INJECTION_LIMIT
  const extraAgentIds = params.extraAgentIds ?? []
  try {
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query.slice(0, 2000))
      } catch {
        queryVec = null
      }
    }

    // Own-agent rows are eligible regardless of kind; extra-agent (holder)
    // rows are additionally restricted to kind:'learning' — see
    // isEligibleMemoryRow. When there are no extraAgentIds this collapses to
    // exactly today's `agentId = params.agentId` behavior.
    const agentPredicate =
      extraAgentIds.length > 0
        ? Prisma.sql`("agentId" = ${params.agentId} OR ("agentId" IN (${Prisma.join(extraAgentIds)}) AND "kind" = 'learning'))`
        : Prisma.sql`"agentId" = ${params.agentId}`

    if (queryVec) {
      const vectorLiteral = toSqlVector(queryVec)
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan keeps recall once the org filter narrows the
        // index's global-nearest candidates (see knowledge/retrieve.ts).
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        return tx.$queryRaw<Array<{ id: string; kind: string; title: string; content: string; question: string | null; distance: number }>>`
          SELECT "id", "kind", "title", "content", "question",
                 ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND ${agentPredicate}
            AND "status" = 'open'
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${k}
        `
      })
      return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: 1 - row.distance }))
    }

    // Keyword fallback: no embeddings configured (or the query embed call
    // failed) — score a bounded scan of the agent's open memories. Same
    // eligibility restriction as the pgvector path above.
    const rows = await prisma.agentMemory.findMany({
      where: {
        organizationId: params.organizationId,
        status: 'open',
        ...(extraAgentIds.length > 0
          ? { OR: [{ agentId: params.agentId }, { agentId: { in: extraAgentIds }, kind: 'learning' }] }
          : { agentId: params.agentId }),
      },
      select: { id: true, kind: true, title: true, content: true, question: true },
      orderBy: { createdAt: 'desc' },
      take: AGENT_MEMORY_CAP,
    })
    if (!rows.length) return []
    const scored = rows.map((row) => {
      const text = `${row.title}\n${row.question ?? ''}\n${row.content}`
      return { id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: keywordScore(params.query, text) }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0).slice(0, k)
  } catch {
    return []
  }
}

/** Render memory + critique blocks for the system prompt. '' when empty. */
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string {
  const parts: string[] = []
  if (hits.length) {
    const body = hits
      .map((h) => {
        if (h.kind === 'user_answer' && h.question) return `— Previously asked: "${h.question}" → the user answered: ${h.content}`
        return `— ${h.title}: ${h.content}`
      })
      .join('\n')
    parts.push(`## What you've learned (from previous runs)\nApply these remembered facts and lessons; do not re-ask questions the user already answered unless something changed.\n\n${body}`)
  }
  if (latestCritique?.trim()) {
    parts.push(`## Notes to self from last run\n${latestCritique.trim()}`)
  }
  return parts.join('\n\n')
}

/** Pure matcher: closest remembered answer for a question, or null. */
export function bestAnswerMatch(
  questionVec: number[] | null,
  question: string,
  candidates: { id: string; question: string | null; content: string; embedding: unknown }[],
): { id: string; content: string; score: number } | null {
  let best: { id: string; content: string; score: number } | null = null
  for (const candidate of candidates) {
    const vec = embeddingOf(candidate.embedding)
    const score =
      questionVec && vec
        ? cosineSimilarity(questionVec, vec)
        : candidate.question
          ? keywordScore(question, candidate.question)
          : 0
    const threshold = questionVec && vec ? MEMORY_SIMILARITY_THRESHOLD : KEYWORD_MATCH_THRESHOLD
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: candidate.id, content: candidate.content, score }
    }
  }
  return best
}

/** Bump usage counters. Best-effort. */
export async function markMemoriesUsed(ids: string[]): Promise<void> {
  if (!ids.length) return
  try {
    // systemPrisma: best-effort usage bump on memory ids drawn from an org-scoped retrieval.
    await systemPrisma.agentMemory.updateMany({
      where: { id: { in: ids } },
      data: { timesUsed: { increment: 1 }, lastUsedAt: new Date() },
    })
  } catch {
    /* best-effort */
  }
}
