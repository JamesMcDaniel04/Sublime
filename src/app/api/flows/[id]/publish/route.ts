import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { serializeFlow } from '@/lib/flows/serialize'
import { recordAudit } from '@/lib/audit'

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
    const flow = await prisma.flow.update({ where: { id }, data: { graph: existing.publishedGraph } })
    return { success: true, flow: serializeFlow(flow) }
  }

  const flow = await prisma.flow.update({
    where: { id },
    data: { publishedGraph: existing.graph ?? {}, version: { increment: 1 } },
  })
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
