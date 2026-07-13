import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import { parseSourceRef, planeLabel } from '@/lib/intelligence/learnings'
import { fromKlavisAgentType, fromNangoProviderKey } from '@/lib/connectors/registry'
import { DELIVERY_PROVIDERS, type DeliveryCapability } from '@/lib/nango/delivery'

export const runtime = 'nodejs'

/**
 * "What Sublime has learned" view — the org's shared behavioral-intelligence
 * memories (learnings distilled from connection scans + workflow
 * suggestions), living under the hidden org-intelligence AgentTask. Kept
 * separate from /api/agents/[id]/memories (which is per real agent, hard
 * deletes, and requires an id param this feature has no agent for).
 */

// Best-effort human label for a memory's sourceRef, so the view can show
// "Slack (Connected account)" instead of a raw `nango:slack` key. A
// connection that no longer exists (already disconnected) falls back to the
// plane's generic label rather than failing the whole request.
async function resolveSourceLabel(organizationId: string, sourceRef: string | null): Promise<string | null> {
  const parsed = parseSourceRef(sourceRef)
  if (!parsed) return null
  const { plane, ref } = parsed
  try {
    if (plane === 'mcp') {
      const connection = await prisma.mcpConnection.findFirst({ where: { id: ref, organizationId }, select: { name: true } })
      return connection?.name ?? planeLabel(plane)
    }
    if (plane === 'klavis') {
      const agent = await prisma.mCPAgent.findFirst({ where: { id: ref, organizationId }, select: { agentType: true } })
      return agent ? fromKlavisAgentType(agent.agentType).label : planeLabel(plane)
    }
    if (plane === 'nango') {
      const keys = DELIVERY_PROVIDERS[ref as DeliveryCapability] as readonly string[] | undefined
      if (!keys) return planeLabel(plane)
      const connected = await prisma.nangoConnection.findFirst({
        where: { organizationId, providerConfigKey: { in: [...keys] } },
        select: { providerConfigKey: true },
      })
      return fromNangoProviderKey(connected?.providerConfigKey ?? keys[0]).label
    }
    return planeLabel(plane)
  } catch {
    return planeLabel(plane)
  }
}

// GET — list the org's open learnings + suggestions, newest first.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const agentId = await findOrgIntelligenceAgentId(auth.organizationId)
  if (!agentId) return { success: true, learnings: [] }

  const rows = await prisma.agentMemory.findMany({
    where: { organizationId: auth.organizationId, agentId, status: 'open', kind: { in: ['learning', 'suggestion'] } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, kind: true, title: true, content: true, sourceRef: true, createdAt: true },
  })

  const learnings = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt,
      source: await resolveSourceLabel(auth.organizationId, row.sourceRef),
    })),
  )

  return { success: true, learnings }
})

const deleteBodySchema = z.object({ id: z.string().min(1) })

// DELETE — dismiss one learning/suggestion (soft delete: status → 'dismissed').
// Never a hard delete here — saveAgentMemory dedupes against
// status IN ('open','dismissed'), so a dismissed row keeps the embedding
// around to stop the same fact/suggestion resurfacing on a later scan.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const url = new URL(request.url)
  const queryId = url.searchParams.get('id')
  const id = queryId ?? deleteBodySchema.parse(await request.json()).id

  const agentId = await findOrgIntelligenceAgentId(auth.organizationId)
  if (!agentId) throw new ApiError('Learning not found', 404, 'NOT_FOUND')

  const updated = await prisma.agentMemory.updateMany({
    where: { id, organizationId: auth.organizationId, agentId, status: 'open' },
    data: { status: 'dismissed' },
  })
  if (updated.count !== 1) throw new ApiError('Learning not found', 404, 'NOT_FOUND')

  return { success: true }
})
