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
  const edges: GraphEdge[] = write.evidenceEventIds.map((eventId) => ({
    organizationId: write.organizationId, from: id, to: userEventNodeId(eventId), rel: 'evidence' as const,
  }))
  // Cross-tool spec §4: a correlation insight also points at the tool nodes it
  // binds, so graph traversal can go pattern → tools → capabilities.
  if (write.slug.startsWith('toolcorr:')) {
    for (const provider of write.slug.replace('toolcorr:', '').split('+')) {
      if (!provider) continue
      edges.push({ organizationId: write.organizationId, from: id, to: nodeIds.tool(provider), rel: 'used_with' })
    }
  }
  // Peer-practices spec: a peer insight also points at the org-shared flow it
  // describes, so traversal can go peer-insight → flow → (runs, agents).
  if (write.slug.startsWith('peer:flow:')) {
    const flowId = write.slug.replace('peer:flow:', '')
    if (flowId) {
      edges.push({ organizationId: write.organizationId, from: id, to: nodeIds.flow(flowId), rel: 'relates_to' })
    }
  }
  return { nodes, edges }
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
