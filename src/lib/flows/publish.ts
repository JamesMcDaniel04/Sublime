/**
 * The ONLY writer of flow publish state (spec 2026-07-24). Publishing means
 * BOTH publishedGraph and status move together — the drift between
 * activate.ts (set both) and the publish route (set only publishedGraph) is
 * the root cause of "published flows invisible to agents".
 *
 * Returns reasons rather than throwing: callers that must not fail a deploy
 * (template provisioning) degrade to DRAFT with the reason; the publish route
 * converts a reason into a 400.
 */
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { agentReadScope } from '@/lib/server/visibility'
import { triggerFromGraph, preserveWebhookSecretHash } from '@/lib/flows/trigger'
import { recordAudit } from '@/lib/audit'
import { recordUserEvent } from '@/lib/behavior/record-event'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export type PublishResult = { published: true; version: number } | { published: false; reason: string }

/** Validate the current draft and make it live (publishedGraph + ACTIVE + version row). */
export async function publishFlowDraft(
  flowId: string,
  organizationId: string,
  userId: string,
): Promise<PublishResult> {
  const existing = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
  if (!existing) return { published: false, reason: 'Flow not found' }

  const parsed = flowGraphSchema.safeParse(existing.graph)
  if (!parsed.success) return { published: false, reason: 'Flow graph is not valid' }
  const graph = parsed.data

  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, connections] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentReadScope(userId) },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(organizationId, { userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog: connections,
  })
  if (!validation.ok) return { published: false, reason: validationErrorMessage(validation) }

  const nextVersion = existing.version + 1
  const trigger = jsonValue(preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger))
  await prisma.$transaction([
    prisma.flow.update({
      where: { id: flowId, organizationId },
      data: { status: 'ACTIVE', trigger, publishedGraph: jsonValue(graph), version: { increment: 1 } },
    }),
    prisma.flowVersion.create({
      data: { flowId, organizationId, version: nextVersion, graph: jsonValue(graph), trigger, publishedBy: userId },
    }),
  ])

  await recordAudit({
    organizationId, actorUserId: userId,
    action: 'flow.published', resourceType: 'flow', resourceId: flowId,
    detail: { version: nextVersion },
  }).catch(() => undefined)
  await recordUserEvent({
    organizationId, userId,
    kind: 'flow_published', resourceType: 'flow', resourceId: flowId,
    context: { name: existing.name, version: nextVersion },
  })
  // Activating a suggested draft = accepting the suggestion (behavioral-
  // intelligence spec §4 feedback loop) — previously only the editor route
  // recorded this; now both entry points do.
  const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? (existing.metadata as Record<string, unknown>) : {}
  if (metadata.suggested === true) {
    await recordUserEvent({
      organizationId, userId,
      kind: 'suggestion_accepted', resourceType: 'flow', resourceId: flowId,
      context: { name: existing.name },
    })
  }
  return { published: true, version: nextVersion }
}

/**
 * Retract a live flow. Keeps the version counter and every FlowVersion row —
 * reusing a number would violate @@unique([flowId, version]) on republish,
 * and destroying restore points is not the inverse of publishing.
 * `disable: true` parks the flow as DISABLED (the flows-list "Disable"
 * action) and is allowed even on a never-published draft.
 */
export async function unpublishFlow(
  flowId: string,
  organizationId: string,
  userId: string,
  options: { disable?: boolean } = {},
): Promise<{ unpublished: true } | { unpublished: false; reason: string }> {
  const existing = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
  if (!existing) return { unpublished: false, reason: 'Flow not found' }
  if (!options.disable && existing.publishedGraph == null) {
    return { unpublished: false, reason: 'Nothing is published' }
  }
  await prisma.flow.update({
    where: { id: flowId, organizationId },
    data: { publishedGraph: Prisma.DbNull, status: options.disable ? 'DISABLED' : 'DRAFT' },
  })
  // Audit only — the behavior ledger's kind union is closed (its kinds feed
  // outcome weighting), and retracting a flow is not a learning signal.
  await recordAudit({
    organizationId, actorUserId: userId,
    action: options.disable ? 'flow.disabled' : 'flow.unpublished',
    resourceType: 'flow', resourceId: flowId,
    detail: { previousVersion: existing.version },
  }).catch(() => undefined)
  return { unpublished: true }
}
