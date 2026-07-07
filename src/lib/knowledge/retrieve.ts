import { prisma } from '@/lib/prisma'
import { embedQuery, embeddingsConfigured } from '@/lib/rag/embeddings'

export type KnowledgeHit = { content: string; filename: string; score: number }

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

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
  return `## Knowledge (from uploaded files)\nUse the following reference material when relevant. Cite the source file when you rely on it.\n\n${body}`
}

/**
 * Retrieve the most relevant knowledge chunks for an agent. Scores by cosine
 * over stored embeddings when available, else by keyword overlap. Best-effort:
 * never throws (returns [] on failure).
 */
export async function retrieveKnowledge(params: {
  organizationId: string
  agentId: string
  query: string
  k?: number
}): Promise<KnowledgeHit[]> {
  const k = params.k ?? 5
  try {
    const chunks = await prisma.knowledgeChunk.findMany({
      // Agent-specific knowledge plus any org-wide knowledge (agentId null).
      where: { organizationId: params.organizationId, OR: [{ agentId: params.agentId }, { agentId: null }] },
      select: { content: true, embedding: true, document: { select: { filename: true } } },
      take: 500,
    })
    if (!chunks.length) return []

    let queryVec: number[] | null = null
    if (embeddingsConfigured()) {
      try {
        queryVec = await embedQuery(params.query)
      } catch {
        queryVec = null
      }
    }

    const scored = chunks.map((chunk) => {
      const emb = Array.isArray(chunk.embedding) ? (chunk.embedding as number[]) : null
      const score = queryVec && emb ? cosine(queryVec, emb) : keywordScore(params.query, chunk.content)
      return { content: chunk.content, filename: chunk.document.filename, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.filter((s) => s.score > 0).slice(0, k)
  } catch {
    return []
  }
}
