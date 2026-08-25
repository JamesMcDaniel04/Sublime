import { EMBEDDING_DIM } from '@/lib/rag/embeddings'

/**
 * Flow-owned vector collections.
 *
 * The platform already embeds and searches for AGENT knowledge (lib/rag).
 * What flows could not do is build and query their OWN index — "embed these
 * tickets, then find the three most similar" — which is most of what a
 * retrieval step is for. These collections are deliberately separate from
 * agent knowledge: mixing arbitrary flow documents into the graph the agents
 * reason over would change what every agent knows as a side effect of someone
 * building a flow.
 */

/** One dimension for the whole platform — see assertEmbeddingDimension. */
export const VECTOR_DIM = EMBEDDING_DIM

const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

/**
 * Normalise a collection name.
 *
 * Lower-cased and trimmed so casing or stray padding cannot fork one
 * collection into two that look identical in the builder.
 *
 * An over-long or unusable name is REFUSED rather than truncated or escaped:
 * truncating would make two distinct collections silently resolve to one, and
 * silently merging someone's indexes is worse than telling them the name is
 * not allowed.
 */
export function normalizeCollection(name: string): string {
  const normalized = String(name ?? '').trim().toLowerCase()
  if (!COLLECTION_RE.test(normalized)) {
    throw new Error(
      'A collection name must be 1-63 characters of letters, numbers, hyphens or underscores.',
    )
  }
  return normalized
}

/**
 * Refuse an embedding that does not belong in this index.
 *
 * **The failure this prevents is the quiet one.** Writing a 1536-dimension
 * OpenAI vector into a 1024-dimension index, or searching one against the
 * other, does not produce an obviously broken result — it produces results
 * ranked by a similarity that means nothing. A retrieval step that returns
 * confident nonsense is worse than one that errors, because nobody
 * investigates it.
 *
 * Non-finite values are refused for the same reason: a single NaN poisons
 * every distance it participates in, and Postgres will not explain why the
 * ranking stopped making sense.
 */
export function assertEmbeddingDimension(embedding: number[]): void {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`An embedding must be an array of ${VECTOR_DIM} numbers — this index expects that dimension.`)
  }
  if (embedding.length !== VECTOR_DIM) {
    throw new Error(
      `This embedding has ${embedding.length} dimensions but the index expects ${VECTOR_DIM}. ` +
      'Mixing embedding models produces rankings that look plausible and mean nothing.',
    )
  }
  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new Error('An embedding must contain only finite numbers.')
  }
}

/**
 * pgvector's `<=>` yields cosine DISTANCE: 0 identical, 2 opposite. People
 * think in similarity, so the conversion happens at this boundary rather than
 * leaking the operator's convention into flow configuration — where getting
 * the comparison backwards silently returns the LEAST similar results.
 */
export function distanceToScore(distance: number): number {
  return 1 - distance
}

export function scoreToDistance(score: number): number {
  return 1 - score
}
