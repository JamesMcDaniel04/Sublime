import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { serializeFlow } from '@/lib/flows/serialize'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { recordAudit } from '@/lib/audit'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// POST /api/flows/[id]/publish — publish the draft (graph → publishedGraph,
// version++), or revert the draft to the published version ({ revert: true }).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { revert } = z.object({ revert: z.boolean().default(false) }).parse(await request.json().catch(() => ({})))

  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  if (revert) {
    if (existing.publishedGraph == null) throw new ApiError('Nothing published to revert to', 400, 'NO_PUBLISHED')
    const flow = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: existing.publishedGraph } })
    return { success: true, flow: serializeFlow(flow) }
  }

  const graph = flowGraphSchema.parse(existing.graph)
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, connections] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: auth.organizationId, status: 'ACTIVE', ...agentVisibilityScope(auth.dbUser.id) },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog: connections,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }

  const nextVersion = existing.version + 1
  const trigger = jsonValue(preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger))
  const [flow] = await prisma.$transaction([
    prisma.flow.update({
      where: { id, organizationId: auth.organizationId },
      data: {
        trigger,
        publishedGraph: existing.graph ?? {},
        version: { increment: 1 },
      },
    }),
    prisma.flowVersion.create({
      data: {
        flowId: id,
        organizationId: auth.organizationId,
        version: nextVersion,
        graph: jsonValue(existing.graph ?? {}),
        trigger,
        publishedBy: auth.dbUser.id,
      },
    }),
  ])
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.published',
    resourceType: 'flow',
    resourceId: id,
    detail: { version: flow.version },
  }).catch(() => undefined)
  return { success: true, flow: serializeFlow(flow) }
})
