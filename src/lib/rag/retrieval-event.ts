/**
 * WorkflowEvent payload builders for retrieval events. Pure so the payload
 * shape is unit-tested; execute-agent supplies the live values. Old events
 * (pre-enrichment) lack strategy/stages/injected — every reader must treat
 * those fields as optional (the trace mappers type them nullable).
 */
import type { RetrievalTrace } from '@/lib/rag/retrieve'

/** chars ≈ tokens × 4 — the assemble.ts budget's own documented estimate. */
const tokensOf = (chars: number) => Math.round(chars / 4)

export type ContextRetrievedPayload = {
  source: 'graph-rag'
  strategy: string
  query: string
  hits: Array<{ type: string; text: string; score: number }>
  related: Array<{ type: string; text: string }>
  stages: RetrievalTrace
  injected: { count: number; ofCandidates: number; tokens: number }
  summary: string
}

export function buildContextRetrievedPayload(input: {
  query: string
  trace: RetrievalTrace
  hits: Array<{ type: string; text: string; score: number }>
  related: Array<{ type: string; text: string }>
  offeredHits: number
  injectedChars: number
}): ContextRetrievedPayload {
  const strategy = ['vector', input.trace.reranked ? 'rerank' : null, input.trace.graphSeeds > 0 ? 'graph' : null]
    .filter(Boolean)
    .join('+')
  return {
    source: 'graph-rag',
    strategy,
    query: input.query,
    hits: input.hits,
    related: input.related,
    stages: input.trace,
    injected: { count: input.hits.length, ofCandidates: input.offeredHits, tokens: tokensOf(input.injectedChars) },
    summary: `Pulled ${input.hits.length} correlated fact(s) + ${input.related.length} connected entit(ies) from Sales AI, integrations, and prior runs.`,
  }
}

export function buildKnowledgeRetrievedPayload(input: {
  query: string
  chunks: Array<{ filename: string; score: number }>
  offered: number
  injectedChars: number
}) {
  return {
    source: 'retained-knowledge' as const,
    query: input.query,
    files: [...new Set(input.chunks.map((chunk) => chunk.filename))],
    chunks: input.chunks,
    injected: { count: input.chunks.length, ofCandidates: input.offered, tokens: tokensOf(input.injectedChars) },
    summary: `Pulled ${input.chunks.length} passage(s) from ${new Set(input.chunks.map((chunk) => chunk.filename)).size} retained source(s).`,
  }
}
