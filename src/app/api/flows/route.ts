import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowOwnerScope, flowReadScope, flowWriteScope, VISIBILITY } from '@/lib/server/visibility'
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
/**
 * Legacy rows/clients carry `visibility: 'shared'` — a value the access rules
 * never honoured, so it never actually shared anything. Treat it as private:
 * turning sharing on must not retroactively expose work whose owner never chose
 * to share it. Only the explicit org_* roles grant org access.
 */
function normalizeVisibility(value: string): string {
  return value === VISIBILITY.orgViewer || value === VISIBILITY.orgEditor ? value : VISIBILITY.private
}

const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).default('DRAFT'),
  // Sharing: private (default), or shared with the org as viewer/editor. Legacy
  // rows/clients may still send 'shared' — a value the access rules never
  // honoured — so it is accepted and normalized to private rather than silently
  // becoming an org-wide share.
  visibility: z.enum(['private', 'org_viewer', 'org_editor', 'shared']).default('private'),
  trigger: triggerSchema.optional(),
  graph: flowGraphSchema.optional(),
  errorFlowId: z.string().min(1).nullable().optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [flows, counts] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    }),
    countActiveConnections(auth.organizationId),
  ])
  const totalConnections = counts.klavis + counts.nango + counts.mcp
  const ready = meetsSuggestionGate(counts)
  return {
    success: true,
    flows: flows.map((flow) => ({
      ...serializeFlow(flow),
      canManageJam: flow.userId === auth.dbUser.id,
    })),
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
    where: { id: body.id, organizationId: auth.organizationId, ...flowWriteScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  if (body.errorFlowId === body.id) throw new ApiError('A flow cannot be its own error handler', 400, 'INVALID_ERROR_HANDLER')
  if (body.errorFlowId) {
    const handler = await prisma.flow.findFirst({
      where: { id: body.errorFlowId, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
      select: { id: true, publishedGraph: true },
    })
    if (!handler?.publishedGraph) throw new ApiError('Choose a published flow you can access as the error handler', 400, 'INVALID_ERROR_HANDLER')
  }
  // Editing content is open to editors; changing WHO can see it is the owner's
  // call alone — otherwise an org_editor could re-share someone else's work.
  const sharingChanged = body.visibility !== undefined && normalizeVisibility(body.visibility) !== existing.visibility
  if (sharingChanged && existing.userId !== auth.dbUser.id) {
    throw new ApiError('Only the flow owner can change who it is shared with', 403, 'FORBIDDEN')
  }
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
  const result = await prisma.flow.updateMany({
    where: {
      id: body.id,
      organizationId: auth.organizationId,
      updatedAt: existing.updatedAt,
      ...flowWriteScope(auth.dbUser.id),
    },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.visibility !== undefined && { visibility: normalizeVisibility(body.visibility) }),
      ...(body.errorFlowId !== undefined && {
        metadata: jsonValue({
          ...(existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : {}),
          errorFlowId: body.errorFlowId || undefined,
        }),
      }),
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
    where: { id: body.id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
  })
  if (!flow) throw new ApiError('Flow not found after save', 404, 'NOT_FOUND')
  return { success: true, flow: serializeFlow(flow) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.flow.deleteMany({
    // Owner only — sharing a flow never grants anyone the right to destroy it.
    where: { id, organizationId: auth.organizationId, ...flowOwnerScope(auth.dbUser.id) },
  })
  if (!result.count) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return { success: true }
})
