/**
 * Graph projection for in-app user events (spec §2):
 *   (actor:sublime:<userId>) -[:performed]-> (uevent activity) -[:on]-> (agent|flow entity)
 * plus per-user preceded_by chains (routine/sequence mining substrate).
 * Activity and actor nodes are PRIVATE to the user; agent/flow entities stay
 * shared (they are org objects that already exist in the graph).
 * Mirrors indexActivity: pure parts + best-effort side-effecting wrapper.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import { getGraphRagStore, graphRagPersistent, ragEnabled } from '@/lib/rag/get-store'
import type { GraphEdge } from '@/lib/rag/store'

export type PersistedUserEvent = {
  id: string
  organizationId: string
  userId: string
  kind: string
  resourceType: string | null
  resourceId: string | null
  context: unknown
  occurredAt: Date
}

export const userEventNodeId = (id: string) => nodeIds.userEvent(id)

function contextName(context: unknown): string | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null
  const name = (context as { name?: unknown }).name
  return typeof name === 'string' && name ? name : null
}

/** Entity node id for the event's resource; agents/flows use canonical ids. */
function resourceNodeId(event: PersistedUserEvent): string | null {
  if (!event.resourceType || !event.resourceId) return null
  if (event.resourceType === 'agent') return nodeIds.agent(event.resourceId)
  if (event.resourceType === 'flow') return nodeIds.flow(event.resourceId)
  return nodeIds.entity('sublime', event.resourceType, event.resourceId)
}

export function userEventGraphParts(
  event: PersistedUserEvent,
  previousEventId?: string | null,
): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const org = event.organizationId
  const activityId = userEventNodeId(event.id)
  const actorId = nodeIds.actor('sublime', event.userId)
  const name = contextName(event.context)
  const target = event.resourceType ? `${event.resourceType} ${name ?? event.resourceId ?? ''}`.trim() : ''

  const nodes: PendingNode[] = [
    {
      id: activityId, type: 'activity',
      text: `User ${event.kind}${target ? ` ${target}` : ''} in Sublime.`,
      props: { kind: event.kind, resourceType: event.resourceType, resourceId: event.resourceId, occurredAt: event.occurredAt.toISOString(), eventId: event.id },
      ownerUserId: event.userId, visibility: 'private',
    },
    {
      id: actorId, type: 'actor',
      text: `Sublime user ${event.userId}`,
      props: { source: 'sublime', actorRef: event.userId },
      ownerUserId: event.userId, visibility: 'private',
    },
  ]

  const edges: GraphEdge[] = [{ organizationId: org, from: actorId, to: activityId, rel: 'performed' }]

  const entityId = resourceNodeId(event)
  if (entityId) {
    // Agents already have rich nodes from indexAgent — an upsert stub here
    // would overwrite them. Everything else gets a lightweight entity stub.
    if (event.resourceType !== 'agent') {
      nodes.push({
        id: entityId, type: 'entity',
        text: `${event.resourceType} ${name ?? event.resourceId} (sublime)`,
        props: { source: 'sublime', entityType: event.resourceType, entityRef: event.resourceId },
      })
    }
    edges.push({ organizationId: org, from: activityId, to: entityId, rel: 'on' })
  }
  if (previousEventId) {
    edges.push({ organizationId: org, from: activityId, to: userEventNodeId(previousEventId), rel: 'preceded_by' })
  }
  return { nodes, edges }
}

/** Best-effort projection; stamps indexedAt so the sweep skips done rows.
 * systemPrisma: worker/cron-internal id-keyed writes on rows the sweep just
 * read — never called from user-facing request paths. */
export async function indexUserEvents(events: PersistedUserEvent[], db = systemPrisma): Promise<void> {
  if (!ragEnabled() || events.length === 0) return
  for (const event of events) {
    try {
      const prior = await db.userEvent.findFirst({
        where: { userId: event.userId, organizationId: event.organizationId, occurredAt: { lt: event.occurredAt }, NOT: { id: event.id } },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      })
      const { nodes, edges } = userEventGraphParts(event, prior?.id ?? null)
      await commitGraph(event.organizationId, nodes, edges)
      await db.userEvent.update({ where: { id: event.id, organizationId: event.organizationId }, data: { indexedAt: new Date() } })
    } catch (error) {
      apiLogger.warn('behavior.indexUserEvents failed', { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Re-index sweep over unprojected rows (indexedAt IS NULL). Returns count attempted.
 * systemPrisma: global cron sweep — reads across all tenants by design. */
export async function sweepUnindexedUserEvents(db = systemPrisma, cap = 200): Promise<number> {
  if (!ragEnabled()) return 0
  const rows = await db.userEvent.findMany({
    where: { indexedAt: null },
    orderBy: { occurredAt: 'asc' },
    take: cap,
  })
  if (rows.length === 0) return 0
  await indexUserEvents(rows as PersistedUserEvent[], db)
  return rows.length
}

/** Retention parity: drop uevent nodes for rows being pruned. Best-effort. */
export async function removeUserEventNodesFromGraph(
  groups: Array<{ organizationId: string; eventIds: string[] }>,
): Promise<void> {
  if (!graphRagPersistent()) return
  const store = getGraphRagStore()
  for (const group of groups) {
    if (group.eventIds.length === 0) continue
    try {
      await store.deleteNodes(group.organizationId, group.eventIds.map(userEventNodeId))
    } catch (error) {
      apiLogger.warn('behavior.removeUserEventNodesFromGraph failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
