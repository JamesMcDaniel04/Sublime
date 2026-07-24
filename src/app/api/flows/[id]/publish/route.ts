import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowOwnerScope } from '@/lib/server/visibility'
import { serializeFlow } from '@/lib/flows/serialize'
import { publishFlowDraft, unpublishFlow } from '@/lib/flows/publish'

const bodySchema = z
  .object({
    revert: z.boolean().default(false),
    unpublish: z.boolean().default(false),
    disable: z.boolean().default(false),
  })
  .refine((body) => [body.revert, body.unpublish, body.disable].filter(Boolean).length <= 1, {
    message: 'Choose one of revert, unpublish, or disable',
  })

// POST /api/flows/[id]/publish — lifecycle endpoint. Default: publish the
// draft. { revert } restores the draft from the published graph. { unpublish }
// retracts to DRAFT. { disable } parks as DISABLED (flows-list "Disable").
// All state changes go through src/lib/flows/publish.ts — the single writer.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { revert, unpublish, disable } = bodySchema.parse(await request.json().catch(() => ({})))

  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowOwnerScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  if (revert) {
    if (existing.publishedGraph == null) throw new ApiError('Nothing published to revert to', 400, 'NO_PUBLISHED')
    const flow = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: existing.publishedGraph } })
    return { success: true, flow: serializeFlow(flow) }
  }

  if (unpublish || disable) {
    const result = await unpublishFlow(id, auth.organizationId, auth.dbUser.id, { disable })
    if (!result.unpublished) throw new ApiError(result.reason, 400, 'NO_PUBLISHED')
  } else {
    const result = await publishFlowDraft(id, auth.organizationId, auth.dbUser.id)
    if (!result.published) throw new ApiError(result.reason, 400, 'FLOW_VALIDATION_ERROR')
  }

  const flow = await prisma.flow.findFirst({ where: { id, organizationId: auth.organizationId } })
  if (!flow) throw new ApiError('Flow not found after update', 404, 'NOT_FOUND')
  return { success: true, flow: serializeFlow(flow) }
})
