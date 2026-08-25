import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { toSqlVector } from '@/lib/rag/embeddings'
import { normalizeCollection, assertEmbeddingDimension, scoreToDistance, distanceToScore } from '@/lib/vector/collection'

/**
 * Reading and writing flow-owned vector collections.
 *
 * Raw SQL because Prisma has no vector type — but every organizationId and
 * collection is a BOUND PARAMETER, never interpolated. A collection name comes
 * from a flow's configuration and is therefore user input; the normaliser
 * constrains its shape, and parameter binding is what actually makes it safe.
 *
 * Every query is scoped by organizationId in its WHERE clause. That is the
 * property that matters most here: a retrieval step that crossed workspaces
 * would feed one customer's documents into another's LLM context, and nothing
 * downstream would notice.
 */

export interface VectorDocumentInput {
  externalId: string
  content: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

export interface VectorHit {
  id: string
  externalId: string
  content: string
  metadata: Record<string, unknown>
  /** Cosine similarity: 1 identical, -1 opposite. */
  score: number
}

/**
 * Insert or update documents.
 *
 * Keyed on (organization, collection, externalId) so re-embedding the same
 * source updates in place rather than accumulating near-duplicates that all
 * match a query and crowd out everything else.
 */
export async function upsertVectorDocuments(
  organizationId: string,
  collection: string,
  documents: VectorDocumentInput[],
): Promise<{ written: number }> {
  const name = normalizeCollection(collection)
  if (documents.length === 0) return { written: 0 }

  // Validated BEFORE any write: a batch half-written with one bad vector
  // leaves a collection nobody can reason about.
  for (const document of documents) assertEmbeddingDimension(document.embedding)

  for (const document of documents) {
    await prisma.$executeRaw`
      INSERT INTO flow_vector_documents ("id", "organizationId", "collection", "externalId", "content", "metadata", "embedding", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${organizationId}::uuid, ${name}, ${document.externalId}, ${document.content},
              ${JSON.stringify(document.metadata ?? {})}::jsonb, ${toSqlVector(document.embedding)}::vector, NOW(), NOW())
      ON CONFLICT ("organizationId", "collection", "externalId")
      DO UPDATE SET "content" = EXCLUDED."content",
                    "metadata" = EXCLUDED."metadata",
                    "embedding" = EXCLUDED."embedding",
                    "updatedAt" = NOW()
    `
  }
  return { written: documents.length }
}

/**
 * Nearest documents to a query embedding.
 *
 * `minScore` is expressed as similarity because that is how people think; it
 * converts to the distance the `<=>` operator actually compares, where getting
 * the direction backwards would silently return the LEAST similar results.
 */
export async function searchVectorDocuments(
  organizationId: string,
  collection: string,
  queryEmbedding: number[],
  options: { limit?: number; minScore?: number } = {},
): Promise<VectorHit[]> {
  const name = normalizeCollection(collection)
  assertEmbeddingDimension(queryEmbedding)

  // Bounded: an unbounded k on a large collection is a slow scan that also
  // floods whatever prompt the results are pasted into.
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 5)), 100)
  const vector = toSqlVector(queryEmbedding)
  const maxDistance = options.minScore === undefined ? null : scoreToDistance(options.minScore)

  const rows = await prisma.$queryRaw<{
    id: string
    externalId: string
    content: string
    metadata: Record<string, unknown>
    distance: number
  }[]>`
    SELECT "id", "externalId", "content", "metadata",
           ("embedding" <=> ${vector}::vector) AS distance
    FROM flow_vector_documents
    WHERE "organizationId" = ${organizationId}::uuid
      AND "collection" = ${name}
      ${maxDistance === null ? Prisma.empty : Prisma.sql`AND ("embedding" <=> ${vector}::vector) <= ${maxDistance}`}
    ORDER BY distance ASC
    LIMIT ${limit}
  `

  return rows.map((row) => ({
    id: row.id,
    externalId: row.externalId,
    content: row.content,
    metadata: row.metadata ?? {},
    score: distanceToScore(Number(row.distance)),
  }))
}

/** Remove documents by their caller-supplied keys. */
export async function deleteVectorDocuments(
  organizationId: string,
  collection: string,
  externalIds: string[],
): Promise<{ deleted: number }> {
  const name = normalizeCollection(collection)
  if (externalIds.length === 0) return { deleted: 0 }

  const deleted = await prisma.flowVectorDocument.deleteMany({
    where: { organizationId, collection: name, externalId: { in: externalIds } },
  })
  return { deleted: deleted.count }
}
