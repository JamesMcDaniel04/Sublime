/**
 * Graph-RAG retrieval: turn a natural-language query (or a set of seed entities)
 * into a correlated context pack the model can reason over.
 *
 * Two-stage, the essence of graph RAG:
 *   1. Vector search finds the semantically closest nodes across every source
 *      (Sales AI signals, run outputs carrying MCP/integration data, account
 *      facts, agents).
 *   2. Graph expansion walks edges from those hits to gather the connected
 *      neighborhood — so a hit on one deal pulls in its account, sibling
 *      opportunities, the signals that fired, and prior agent runs. This is
 *      what surfaces cross-source correlations a flat vector search misses.
 *
 * Pure orchestration over the store + embedder; both are injected so the
 * ranking/rendering logic is unit-testable without network or a graph DB.
 */

import { embedQuery, rerankTexts, type EmbedOptions } from './embeddings'
import { ragEnabled } from './get-store'
import type { GraphNode, GraphRagStore, SearchHit } from './store'

export interface RetrieveOptions {
  organizationId: string
  /**
   * The rep this retrieval is for. Scopes results to shared nodes + this rep's
   * own private nodes; pass null to see only shared nodes. Omitting it defaults
   * to null (shared-only) — callers with a user MUST pass it to see private data.
   */
  viewerUserId?: string | null
  /** Free-text query (assistant question, or the agent objective + signal). */
  query: string
  /** Optional known entity node ids to seed expansion from (e.g. the signal's account). */
  seedNodeIds?: string[]
  topK?: number
  hops?: number
  maxNodes?: number
  /** Drop vector hits scoring below this cosine similarity (default 0.25). */
  minScore?: number
  embed?: (text: string, options?: EmbedOptions) => Promise<number[]>
  /** Injectable for tests; defaults to the Voyage rerank (no-op unless enabled). */
  rerank?: typeof rerankTexts
}

/**
 * Stage-funnel telemetry for one retrieval: how many candidates each pipeline
 * stage admitted. Recorded on every pack (zeros when retrieval is disabled)
 * so run traces can show WHY the model knew something — which strategy ran
 * and what survived each cut.
 */
export interface RetrievalTrace {
  candidates: number
  afterScoreFloor: number
  reranked: boolean
  afterRerank: number
  graphSeeds: number
  relatedFound: number
  relatedKept: number
  minScore: number
  topK: number
  hops: number
}

export function emptyRetrievalTrace(topK: number, hops: number, minScore: number): RetrievalTrace {
  return {
    candidates: 0,
    afterScoreFloor: 0,
    reranked: false,
    afterRerank: 0,
    graphSeeds: 0,
    relatedFound: 0,
    relatedKept: 0,
    minScore,
    topK,
    hops,
  }
}

export interface RetrievedContext {
  /** Direct semantic hits, most relevant first. */
  hits: Array<{ id: string; type: string; text: string; score: number; props: Record<string, unknown> }>
  /** Connected neighbors reached by graph expansion. */
  related: Array<{ id: string; type: string; text: string; props: Record<string, unknown> }>
  trace: RetrievalTrace
}

const truncate = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * Recency weight for ranking (seam 9-lite): exponential decay with a 30-day
 * half-life, floored so old-but-relevant facts still surface. A node with no
 * updatedAt gets the floor (treat unknown age as old).
 */
export function recencyWeight(updatedAt: string | undefined, now: number = Date.now()): number {
  if (!updatedAt) return 0.5
  const at = new Date(updatedAt).getTime()
  if (Number.isNaN(at)) return 0.5
  const days = Math.max(0, (now - at) / 86_400_000)
  return Math.max(0.5, 2 ** (-days / 30))
}

/**
 * Retrieve correlated context. Returns an empty pack (never throws) when
 * embeddings aren't configured or the store is empty, so callers can always
 * fold the result in unconditionally.
 */
export async function retrieveContext(
  store: GraphRagStore,
  options: RetrieveOptions,
): Promise<RetrievedContext> {
  const topK = options.topK ?? 6
  const hops = options.hops ?? 2
  const maxNodes = options.maxNodes ?? 16
  const embed = options.embed ?? embedQuery
  const viewerUserId = options.viewerUserId ?? null
  const minScore = options.minScore ?? 0.25

  if (!ragEnabled() && !options.embed) {
    return { hits: [], related: [], trace: emptyRetrievalTrace(topK, hops, minScore) }
  }

  const rerank = options.rerank ?? rerankTexts
  let searchHits: SearchHit[] = []
  try {
    const queryVector = await embed(options.query, { inputType: 'query' })
    if (queryVector.length > 0) {
      searchHits = await store.search(options.organizationId, viewerUserId, queryVector, topK)
    }
  } catch {
    // Retrieval is best-effort — a failed embed/search must not break the caller.
    searchHits = []
  }
  const candidates = searchHits.length
  // Score floor: below-threshold cosine hits are noise that would seed graph
  // expansion from the wrong neighborhood — drop them before anything else.
  searchHits = searchHits.filter((h) => h.score >= minScore)
  const afterScoreFloor = searchHits.length
  // Recency-aware ordering: same-relevance facts prefer the fresher node
  // (cosine still reported as `score`; ordering blends a 30-day-half-life
  // decay so stale intel doesn't outrank this week's).
  searchHits = searchHits
    .map((h) => ({ hit: h, effective: h.score * (0.85 + 0.15 * recencyWeight(h.node.updatedAt)) }))
    .sort((a, b) => b.effective - a.effective)
    .map((entry) => entry.hit)
  // Optional Voyage rerank (VOYAGE_RERANK_MODEL): reorder by cross-encoder
  // relevance; below-0.1 rerank scores are dropped as off-topic.
  let reranked = false
  if (searchHits.length > 1) {
    const ranked = await rerank(options.query, searchHits.map((h) => h.node.text))
    if (ranked) {
      reranked = true
      searchHits = ranked.filter((row) => row.score >= 0.1).map((row) => searchHits[row.index]).filter(Boolean)
    }
  }
  const afterRerank = searchHits.length

  const seedIds = [...new Set([...(options.seedNodeIds ?? []), ...searchHits.map((h) => h.node.id)])]
  let related: GraphNode[] = []
  if (seedIds.length > 0) {
    try {
      related = await store.expand(options.organizationId, viewerUserId, seedIds, hops)
    } catch {
      related = []
    }
  }

  const hitIds = new Set(searchHits.map((h) => h.node.id))
  const relatedTrimmed = related.filter((n) => !hitIds.has(n.id)).slice(0, maxNodes)

  return {
    hits: searchHits.map((h) => ({
      id: h.node.id, type: h.node.type, score: Number(h.score.toFixed(4)),
      text: truncate(h.node.text), props: h.node.props,
    })),
    related: relatedTrimmed.map((n) => ({
      id: n.id, type: n.type, text: truncate(n.text), props: n.props,
    })),
    trace: {
      candidates,
      afterScoreFloor,
      reranked,
      afterRerank,
      graphSeeds: seedIds.length,
      relatedFound: related.length,
      relatedKept: relatedTrimmed.length,
      minScore,
      topK,
      hops,
    },
  }
}

/** Render a context pack into compact markdown for a system/user prompt.
 *  Accepts the hits/related subset so budget-trimmed packs (and telemetry-free
 *  fallbacks) render without carrying a trace. */
export function renderContext(context: Pick<RetrievedContext, 'hits' | 'related'>): string {
  if (context.hits.length === 0 && context.related.length === 0) return ''
  const lines: string[] = ['## Correlated context (Sales AI, integrations, prior runs)']
  if (context.hits.length) {
    lines.push('', 'Most relevant:')
    for (const h of context.hits) lines.push(`- [${h.type}] ${h.text}`)
  }
  if (context.related.length) {
    lines.push('', 'Connected to the above:')
    for (const r of context.related) lines.push(`- [${r.type}] ${r.text}`)
  }
  // Grounding contract (mirrors the uploaded-file knowledge block): claims
  // sourced from this context must say where they came from, so answers stay
  // auditable against the graph instead of blending facts invisibly.
  lines.push(
    '',
    'When your answer uses a fact from this correlated context, attribute it inline (e.g. "per the account status" or "from a prior run"). Never present a correlated fact as something you observed live this run.',
  )
  return lines.join('\n')
}
