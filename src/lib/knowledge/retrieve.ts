import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedQuery, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { decryptKnowledgeContent } from './store'

const KEYWORD_SCAN_CAP = 500

export type KnowledgeHit = { content: string; filename: string; sourceType?: string; score: number }

/** Fallback relevance when embeddings are unavailable: query-term overlap. */
export function keywordScore(query: string, content: string): number {
  const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  if (!terms.length) return 0
  const haystack = content.toLowerCase()
  let hits = 0
  for (const term of new Set(terms)) if (haystack.includes(term)) hits += 1
  return hits / new Set(terms).size
}

/** Render knowledge hits into a compact block for the agent's system prompt. */
export function renderKnowledge(hits: KnowledgeHit[]): string {
  if (!hits.length) return ''
  const body = hits.map((h) => `— From "${h.filename}":\n${h.content}`).join('\n\n')
  return `## Retained workspace knowledge\nUse the following private reference material when relevant. Cite the source when you rely on it.\n\n${body}`
}

/**
 * Retrieve the most relevant knowledge chunks for an agent. Ranks in-database
 * by pgvector cosine distance (HNSW index) over ALL of the org/agent's
 * embedded chunks when embeddings are available, else falls back to keyword
 * overlap over a bounded scan. Best-effort: never throws (returns [] on
 * failure).
 */
export async function retrieveKnowledge(params: {
  organizationId: string
  agentId: string
  userId?: string | null
  query: string
  k?: number
}): Promise<KnowledgeHit[]> {
  const k = params.k ?? 5
  try {
    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query)
      } catch {
        queryVec = null
      }
    }

    if (queryVec) {
      const vectorLiteral = toSqlVector(queryVec)
      // search_path guard: Supabase installs pgvector into `extensions`, and a
      // client session's default search_path isn't guaranteed to include it.
      // SET LOCAL scopes the widened path to this transaction only, so the
      // `::vector(1024)` cast resolves regardless of the session default.
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        // HNSW iterative scan: the index returns global-nearest candidates
        // BEFORE our organizationId filter, so without this a small org can
        // under-return (or get zero) once the table is large enough for the
        // planner to pick the index. Relaxed order keeps recall with the filter.
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'")
        return tx.$queryRaw<Array<{ content: string; contentEncrypted: string | null; filename: string; sourceType: string; distance: number }>>`
          SELECT c."content" AS content, c."contentEncrypted" AS "contentEncrypted",
                 d."filename" AS filename, d."sourceType" AS "sourceType",
                 (c."embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "knowledge_chunks" c
          JOIN "knowledge_documents" d ON d."id" = c."documentId"
          WHERE c."organizationId" = ${params.organizationId}::uuid
            AND d."status" = 'ready'
            AND (d."expiresAt" IS NULL OR d."expiresAt" > NOW())
            AND (
              d."visibility" = 'organization'
              OR (d."visibility" = 'agent' AND c."agentId" = ${params.agentId})
              OR (d."visibility" = 'private' AND d."userId" = ${params.userId ?? ''})
            )
            AND c."embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${k}
        `
      })
      // A row whose decryption fails AND has no legacy plaintext yields an
      // empty body — drop it rather than feeding a blank "source" to the
      // agent as if it were retrieved knowledge.
      return rows
        .map((row) => ({
          content: decryptKnowledgeContent(row.contentEncrypted, row.content),
          filename: row.filename,
          sourceType: row.sourceType,
          score: 1 - row.distance,
        }))
        .filter((hit) => hit.content.trim().length > 0)
    }

    // Keyword fallback: no embeddings configured (or the query embed call
    // failed) — score a bounded scan of the org/agent's chunks by term overlap.
    const chunks = await prisma.knowledgeChunk.findMany({
      where: {
        organizationId: params.organizationId,
        document: {
          status: 'ready',
          OR: [
            { visibility: 'organization' },
            { visibility: 'agent', agentId: params.agentId },
            ...(params.userId ? [{ visibility: 'private', userId: params.userId }] : []),
          ],
          AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
        },
      },
      select: { content: true, contentEncrypted: true, document: { select: { filename: true, sourceType: true } } },
      // The scan is bounded, so make the bound deterministic and useful:
      // newest documents first, instead of whatever page order Postgres picks.
      orderBy: { document: { updatedAt: 'desc' } },
      take: KEYWORD_SCAN_CAP,
    })
    if (chunks.length === KEYWORD_SCAN_CAP) {
      // Silent truncation reads as "searched everything" — surface it.
      apiLogger.warn('retrieveKnowledge: keyword fallback hit scan cap; older knowledge not searched', {
        organizationId: params.organizationId,
        agentId: params.agentId,
        cap: KEYWORD_SCAN_CAP,
      })
    }
    if (!chunks.length) return []
    const scored = chunks.map((chunk) => {
      const content = decryptKnowledgeContent(chunk.contentEncrypted, chunk.content)
      return {
        content,
        filename: chunk.document.filename,
        sourceType: chunk.document.sourceType,
        score: keywordScore(params.query, content),
      }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0 && s.content.trim().length > 0).slice(0, k)
  } catch (error) {
    // Best-effort contract: an agent run must not fail because retrieval did —
    // but a silent [] here also silently degrades every run, so always log.
    apiLogger.warn('retrieveKnowledge failed; continuing without knowledge', {
      organizationId: params.organizationId,
      agentId: params.agentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
