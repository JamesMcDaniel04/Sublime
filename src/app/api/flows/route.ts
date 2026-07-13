import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { serializeFlow } from '@/lib/flows/serialize'
import { hasSaveConflict } from '@/lib/flows/save-conflict'
import { normalizeFlowTrigger, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { countActiveConnections, meetsSuggestionGate } from '@/lib/intelligence/suggest-workflows'

// Strip undefined + narrow to plain JSON so Prisma's InputJsonValue accepts the
// zod-inferred shapes (passthrough trigger / discriminated-union graph).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const triggerSchema = z.object({ type: z.enum(['manual', 'schedule', 'webhook', 'signal']).default('manual') }).passthrough()
const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).default('DRAFT'),
  // Accepted for older clients, but flows are always personal workspace data.
  visibility: z.enum(['shared', 'private']).default('private'),
  trigger: triggerSchema.optional(),
  graph: flowGraphSchema.optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [flows, counts] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    countActiveConnections(auth.organizationId),
  ])
  const totalConnections = counts.klavis + counts.nango + counts.mcp
  const ready = meetsSuggestionGate(counts)
  return {
    success: true,
    flows: flows.map(serializeFlow),
    // Behavioral-intelligence: drives the flows-page "Suggested for you" rail
    // vs. its below-gate progress copy.
    suggestionReadiness: { ready, totalConnections, connectionsNeeded: ready ? 0 : Math.max(0, 3 - totalConnections) },
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = flowSchema.parse(await request.json())
  const graph = data.graph ?? emptyGraph()
  const trigger = data.trigger ? normalizeFlowTrigger(data.trigger) : triggerFromGraph(graph)
  const flow = await prisma.flow.create({
    data: {
      name: data.name,
      description: data.description,
      status: data.status,
      visibility: 'private',
      trigger: jsonValue(trigger),
      graph: jsonValue(graph),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ id: z.string().min(1), baseUpdatedAt: z.string().optional() })
    .merge(flowSchema.partial())
    .parse(await request.json())
  const existing = await prisma.flow.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  // Optimistic concurrency: reject a save based on a stale copy instead of
  // silently clobbering another editor's changes (two tabs / Flow Jam).
  if (hasSaveConflict(existing.updatedAt, body.baseUpdatedAt)) {
    throw new ApiError(
      'Someone else saved this flow since you loaded it — copy any unsaved edits, then reload to pick up their changes.',
      409,
      'FLOW_SAVE_CONFLICT',
    )
  }
  const nextTrigger =
    body.trigger !== undefined
      ? normalizeFlowTrigger(body.trigger)
      : body.graph !== undefined
        ? triggerFromGraph(body.graph, existing.trigger)
        : undefined
  // Compare-and-swap closes the race between the conflict check above and the
  // write itself. Collaboration patches and manual saves can never pass the
  // same stale updatedAt check and then overwrite each other.
  const result = await prisma.flow.updateMany({
    where: {
      id: body.id,
      organizationId: auth.organizationId,
      updatedAt: existing.updatedAt,
    },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.visibility !== undefined && { visibility: 'private' }),
      // Preserve the webhook secret hash across trigger edits — the client
      // never sees it, so a plain PUT would silently wipe it.
      ...(nextTrigger !== undefined && { trigger: jsonValue(preserveWebhookSecretHash(nextTrigger, existing.trigger)) }),
      ...(body.graph !== undefined && { graph: jsonValue(body.graph) }),
      ...(body.graph !== undefined && { collaborationRevision: { increment: 1 } }),
    },
  })
  if (!result.count) {
    throw new ApiError(
      'Someone else changed this flow while you were saving. The shared draft was not overwritten.',
      409,
      'FLOW_SAVE_CONFLICT',
    )
  }
  const flow = await prisma.flow.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found after save', 404, 'NOT_FOUND')
  return { success: true, flow: serializeFlow(flow) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.flow.deleteMany({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!result.count) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return { success: true }
})
