/**
 * The trust layer (spec §8). Facts are activity nodes; inferences are insight
 * nodes that MUST cite their facts:
 *   inferred_pattern  -[:evidence]->  activity   (>=1 required)
 *   recommendation    -[:based_on]->  inferred_pattern (>=1 required)
 * The invariant is enforced structurally before an inference reaches the graph.
 */
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import type { GraphEdge } from '@/lib/rag/store'

export interface InferenceWrite {
  organizationId: string
  kind: 'inferred_pattern' | 'recommendation'
  slug: string
  text: string
  evidenceEventIds: string[]
  basedOnInsightIds?: string[]
}

export const insightNodeId = (kind: InferenceWrite['kind'], slug: string) =>
  `insight:activity:${kind}:${slug}`

export function inferenceGraphParts(write: InferenceWrite): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const citations = write.kind === 'recommendation'
    ? (write.basedOnInsightIds ?? [])
    : write.evidenceEventIds

  if (citations.length === 0) throw new Error('inference rejected: no evidence')

  const id = insightNodeId(write.kind, write.slug)
  const nodes: PendingNode[] = [{
    id,
    type: 'insight',
    text: `${write.kind === 'recommendation' ? 'Recommendation' : 'Inferred pattern'}: ${write.text}`.slice(0, 1800),
    props: { insightKind: write.kind, slug: write.slug, evidenceCount: citations.length },
    visibility: 'shared',
  }]
  const edges: GraphEdge[] = write.kind === 'recommendation'
    ? citations.map((to) => ({ organizationId: write.organizationId, from: id, to, rel: 'based_on' as const }))
    : citations.map((eventId) => ({
        organizationId: write.organizationId,
        from: id,
        to: nodeIds.activity(eventId),
        rel: 'evidence' as const,
      }))

  return { nodes, edges }
}

/** Invariant violations throw; graph-store failures remain best-effort. */
export async function writeInference(write: InferenceWrite): Promise<boolean> {
  const { nodes, edges } = inferenceGraphParts(write)
  try {
    await commitGraph(write.organizationId, nodes, edges)
    return true
  } catch (error) {
    apiLogger.warn('rag.writeInference failed', {
      slug: write.slug,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
