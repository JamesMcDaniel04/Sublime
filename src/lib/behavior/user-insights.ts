/**
 * Per-user trust layer (spec §3): behavior patterns are insight nodes that
 * MUST cite user_event evidence, private to their owner. Mirrors
 * src/lib/activity/insights.ts with uevent evidence targets + private scope.
 */
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import type { GraphEdge } from '@/lib/rag/store'
import { userEventNodeId } from './index-user-event'

export interface UserInferenceWrite {
  organizationId: string
  userId: string
  slug: string
  text: string
  evidenceEventIds: string[]
}

export const userPatternNodeId = (slug: string) => `insight:behavior:${slug}`

export function userInferenceGraphParts(write: UserInferenceWrite): { nodes: PendingNode[]; edges: GraphEdge[] } {
  if (write.evidenceEventIds.length === 0) throw new Error('inference rejected: no evidence')
  const id = userPatternNodeId(write.slug)
  const nodes: PendingNode[] = [{
    id, type: 'insight',
    text: `Behavior pattern: ${write.text}`.slice(0, 1800),
    props: { insightKind: 'behavior_pattern', slug: write.slug, evidenceCount: write.evidenceEventIds.length },
    ownerUserId: write.userId, visibility: 'private',
  }]
  const edges: GraphEdge[] = [
    ...write.evidenceEventIds.map((eventId) => ({
      organizationId: write.organizationId, from: id, to: userEventNodeId(eventId), rel: 'evidence' as const,
    })),
    ...slugTopologyEdges(write.organizationId, id, write.slug),
  ]
  return { nodes, edges }
}

/**
 * Topology edges derived from a pattern's slug, so graph traversal can go
 * pattern → tools/flows: correlation and archetype insights point at the tool
 * nodes they bind (cross-tool spec §4, platform-archetypes spec); peer
 * insights point at the org-shared flow they describe (peer-practices spec).
 */
function slugTopologyEdges(organizationId: string, insightId: string, slug: string): GraphEdge[] {
  const toolEdge = (provider: string): GraphEdge => ({ organizationId, from: insightId, to: nodeIds.tool(provider), rel: 'used_with' })
  if (slug.startsWith('toolcorr:')) {
    return slug.replace('toolcorr:', '').split('+').filter(Boolean).map(toolEdge)
  }
  if (slug.startsWith('archetype:')) {
    const signature = slug.replace('archetype:', '')
    return signature.slice(0, signature.lastIndexOf(':')).split('+').filter(Boolean).map(toolEdge)
  }
  if (slug.startsWith('peer:flow:')) {
    const flowId = slug.replace('peer:flow:', '')
    return flowId ? [{ organizationId, from: insightId, to: nodeIds.flow(flowId), rel: 'relates_to' }] : []
  }
  return []
}

/** Invariant violations throw; graph-store failures remain best-effort. */
export async function writeUserInference(write: UserInferenceWrite): Promise<boolean> {
  const { nodes, edges } = userInferenceGraphParts(write)
  try {
    await commitGraph(write.organizationId, nodes, edges)
    return true
  } catch (error) {
    apiLogger.warn('behavior.writeUserInference failed', { slug: write.slug, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
