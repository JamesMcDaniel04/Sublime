/**
 * Nightly re-embed sweep (ARCHITECTURE tech-debt item): rows written while
 * VOYAGE_API_KEY was unset — or whose embed call failed at write time — have
 * `embeddingVec IS NULL` and are invisible to vector retrieval forever.
 * This sweep backfills them in bounded batches so the corpus converges within
 * a few nights of embeddings being (re)configured.
 *
 * Embed inputs mirror the write paths exactly:
 *   - agent_memories: user_answer embeds question ?? content; everything else
 *     embeds "title\ncontent" (see saveAgentMemory).
 *   - knowledge_chunks: the chunk content (see ingestKnowledge).
 *
 * Gated on embeddings being configured; never throws — the cron caller treats
 * any failure as "try again tomorrow".
 */
import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { decryptKnowledgeContent } from '@/lib/knowledge/store'

const DEFAULT_CAP = 100

type SweepResult = { memories: number; chunks: number } | { skipped: string }

export async function reEmbedMissingVectors(db = systemPrisma, cap = DEFAULT_CAP): Promise<SweepResult> {
  if (!embeddingsConfigured()) return { skipped: 'embeddings-not-configured' }
  try {
    const [memories, chunks] = await Promise.all([
      db.$queryRaw<Array<{ id: string; organizationId: string; kind: string; title: string; content: string; question: string | null }>>`
        SELECT "id", "organizationId", "kind", "title", "content", "question"
        FROM "agent_memories"
        WHERE "embeddingVec" IS NULL AND "status" <> 'superseded'
        ORDER BY "createdAt" ASC
        LIMIT ${cap}
      `,
      db.$queryRaw<Array<{ id: string; organizationId: string; content: string; contentEncrypted: string | null }>>`
        SELECT c."id", c."organizationId", c."content", c."contentEncrypted"
        FROM "knowledge_chunks" c
        JOIN "knowledge_documents" d ON d."id" = c."documentId"
        WHERE c."embeddingVec" IS NULL
        ORDER BY d."createdAt" ASC, c."ordinal" ASC
        LIMIT ${cap}
      `,
    ])
    if (memories.length === 0 && chunks.length === 0) return { memories: 0, chunks: 0 }

    const memoryTexts = memories.map((m) =>
      m.kind === 'user_answer' ? (m.question ?? m.content) : `${m.title}\n${m.content}`,
    )
    const vectors = await embedTexts([
      ...memoryTexts,
      ...chunks.map((c) => decryptKnowledgeContent(c.contentEncrypted, c.content)),
    ], { inputType: 'document' })

    // One VALUES-join transaction per table (the pattern ingestKnowledge
    // already uses) — this was one transaction PER ROW, up to 200 sequential
    // round-trips each paying SET LOCAL + commit, fully serializing behind
    // live traffic on a small pool.
    const memoryRows = memories
      .map((m, i) => ({ id: m.id, organizationId: m.organizationId, vec: vectors[i] }))
      .filter((r): r is typeof r & { vec: number[] } => Boolean(r.vec && r.vec.length > 0))
    if (memoryRows.length > 0) {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        const values = memoryRows.map((r) => Prisma.sql`(${r.id}, ${r.organizationId}::uuid, ${toSqlVector(r.vec)}::vector(1024))`)
        await tx.$executeRaw`
          UPDATE "agent_memories" AS m SET "embeddingVec" = v.vec
          FROM (VALUES ${Prisma.join(values)}) AS v(id, org, vec)
          WHERE m."id" = v.id AND m."organizationId" = v.org
        `
      })
    }
    const chunkRows = chunks
      .map((c, i) => ({ id: c.id, organizationId: c.organizationId, vec: vectors[memories.length + i] }))
      .filter((r): r is typeof r & { vec: number[] } => Boolean(r.vec && r.vec.length > 0))
    if (chunkRows.length > 0) {
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        const values = chunkRows.map((r) => Prisma.sql`(${r.id}, ${r.organizationId}::uuid, ${toSqlVector(r.vec)}::vector(1024))`)
        await tx.$executeRaw`
          UPDATE "knowledge_chunks" AS c SET "embeddingVec" = v.vec
          FROM (VALUES ${Prisma.join(values)}) AS v(id, org, vec)
          WHERE c."id" = v.id AND c."organizationId" = v.org
        `
      })
    }
    return { memories: memoryRows.length, chunks: chunkRows.length }
  } catch (error) {
    apiLogger.warn('reEmbedMissingVectors failed', { error: error instanceof Error ? error.message : String(error) })
    return { skipped: 'error' }
  }
}
