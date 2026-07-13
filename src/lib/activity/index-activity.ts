/**
 * Graph projection for activity events (spec §5):
 *   (actor)-[:performed]->(activity)-[:on]->(entity)
 * plus participant, relates_to (account/opportunity anchors), and
 * preceded_by (state-history chains on the same entity).
 *
 * activityGraphParts is pure (unit-testable without a store); indexActivity
 * is the best-effort side-effecting wrapper, mirroring indexSignal.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import { ragEnabled } from '@/lib/rag/get-store'
import type { GraphEdge } from '@/lib/rag/store'
import type { PersistedActivity } from './ledger'

const nid = nodeIds

function stateSummary(event: PersistedActivity): string {
  if (event.previousState == null && event.newState == null) return ''
  const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null))
  return ` Changed from ${fmt(event.previousState)} to ${fmt(event.newState)}.`
}

export function activityGraphParts(
  event: PersistedActivity,
  previousEventId?: string | null,
): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const org = event.organizationId
  const activityId = nid.activity(event.id)
  const actorId = nid.actor(event.source, event.actorRef)
  const entityId = nid.entity(event.source, event.entityType, event.entityRef)
  const actorLabel = event.actorName ?? event.actorRef
  const entityLabel = event.entityName ?? event.entityRef

  const nodes: PendingNode[] = [
    {
      id: activityId, type: 'activity',
      text: `${actorLabel} ${event.action} ${event.entityType} ${entityLabel} in ${event.source}.${stateSummary(event)}${event.outcome ? ` Outcome: ${event.outcome}.` : ''}`,
      props: {
        source: event.source, action: event.action, entityType: event.entityType,
        entityRef: event.entityRef, occurredAt: event.occurredAt.toISOString(),
        ingestKind: event.ingestKind, eventId: event.id,
      },
    },
    { id: actorId, type: 'actor', text: `${actorLabel} (${event.source} user ${event.actorRef})`, props: { source: event.source, actorRef: event.actorRef } },
    { id: entityId, type: 'entity', text: `${event.entityType} ${entityLabel} (${event.source})`, props: { source: event.source, entityType: event.entityType, entityRef: event.entityRef } },
  ]

  const edges: GraphEdge[] = [
    { organizationId: org, from: actorId, to: activityId, rel: 'performed' },
    { organizationId: org, from: activityId, to: entityId, rel: 'on' },
  ]
  for (const participant of event.participants ?? []) {
    if (participant === event.actorRef) continue
    const pid = nid.actor(event.source, participant)
    if (!nodes.some((n) => n.id === pid)) {
      nodes.push({ id: pid, type: 'actor', text: `${participant} (${event.source} user ${participant})`, props: { source: event.source, actorRef: participant } })
    }
    edges.push({ organizationId: org, from: activityId, to: pid, rel: 'participant' })
  }
  const context = (event.businessContext ?? {}) as { accountId?: unknown; opportunityId?: unknown }
  if (typeof context.accountId === 'string' && context.accountId) {
    edges.push({ organizationId: org, from: activityId, to: nid.account(context.accountId), rel: 'relates_to' })
  }
  if (typeof context.opportunityId === 'string' && context.opportunityId) {
    edges.push({ organizationId: org, from: activityId, to: nid.opportunity(context.opportunityId), rel: 'relates_to' })
  }
  if (previousEventId) {
    edges.push({ organizationId: org, from: activityId, to: nid.activity(previousEventId), rel: 'preceded_by' })
  }
  return { nodes, edges }
}

/** Index persisted events into the graph, best-effort; stamps indexedAt on
 * success so the re-index sweep (indexedAt IS NULL) skips them. */
export async function indexActivity(events: PersistedActivity[]): Promise<void> {
  if (!ragEnabled() || events.length === 0) return
  for (const event of events) {
    try {
      // preceded_by: latest prior event on the same entity (state chain).
      const prior = await prisma.activityEvent.findFirst({
        where: {
          organizationId: event.organizationId, source: event.source,
          entityType: event.entityType, entityRef: event.entityRef,
          occurredAt: { lt: event.occurredAt }, NOT: { id: event.id },
        },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      })
      const { nodes, edges } = activityGraphParts(event, prior?.id ?? null)
      await commitGraph(event.organizationId, nodes, edges)
      await prisma.activityEvent.update({
        where: { id: event.id, organizationId: event.organizationId },
        data: { indexedAt: new Date() },
      })
    } catch (error) {
      apiLogger.warn('rag.indexActivity failed', { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
