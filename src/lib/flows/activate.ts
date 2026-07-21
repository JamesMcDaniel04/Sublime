/**
 * Programmatic flow activation — the same contract the editor's publish route
 * establishes (validate → publishedGraph + version row → status ACTIVE; the
 * cron dispatcher only fires flows holding status AND publishedGraph).
 * Callers that can't block a deploy on a bad graph degrade to DRAFT with the
 * validation reason instead of throwing.
 */
import { prisma } from '@/lib/prisma'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { agentReadScope } from '@/lib/server/visibility'
import { triggerFromGraph, preserveWebhookSecretHash } from '@/lib/flows/trigger'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export type ActivateFlowResult = { activated: true } | { activated: false; reason: string }

/**
 * Validate and activate a flow's current draft graph. Returns rather than
 * throws on validation failure — the flow stays DRAFT and the caller surfaces
 * the reason.
 */
export async function activateFlow(
  flowId: string,
  organizationId: string,
  userId: string,
): Promise<ActivateFlowResult> {
  const existing = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
  if (!existing) return { activated: false, reason: 'Flow not found' }

  const parsed = flowGraphSchema.safeParse(existing.graph)
  if (!parsed.success) return { activated: false, reason: 'Flow graph is not valid' }
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
  if (!validation.ok) return { activated: false, reason: validationErrorMessage(validation) }

  const nextVersion = existing.version + 1
  const trigger = jsonValue(preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger))
  await prisma.$transaction([
    prisma.flow.update({
      where: { id: flowId, organizationId },
      data: {
        status: 'ACTIVE',
        trigger,
        publishedGraph: jsonValue(graph),
        version: { increment: 1 },
      },
    }),
    prisma.flowVersion.create({
      data: {
        flowId,
        organizationId,
        version: nextVersion,
        graph: jsonValue(graph),
        trigger,
        publishedBy: userId,
      },
    }),
  ])
  return { activated: true }
}
