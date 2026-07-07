import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { serializeFlow } from '@/lib/flows/serialize'

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
  visibility: z.enum(['shared', 'private']).default('shared'),
  trigger: triggerSchema.default({ type: 'manual' }),
  graph: flowGraphSchema.default(emptyGraph()),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return { success: true, flows: flows.map(serializeFlow) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = flowSchema.parse(await request.json())
  const flow = await prisma.flow.create({
    data: {
      name: data.name,
      description: data.description,
      status: data.status,
      visibility: data.visibility,
      trigger: jsonValue(data.trigger),
      graph: jsonValue(data.graph),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, flow: serializeFlow(flow) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(flowSchema.partial()).parse(await request.json())
  const existing = await prisma.flow.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const flow = await prisma.flow.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      // Preserve the webhook secret hash across trigger edits — the client
      // never sees it, so a plain PUT would silently wipe it.
      ...(body.trigger !== undefined && {
        trigger: jsonValue({
          ...body.trigger,
          ...((existing.trigger as Record<string, unknown> | null)?.webhookSecretHash
            ? { webhookSecretHash: (existing.trigger as Record<string, unknown>).webhookSecretHash }
            : {}),
        }),
      }),
      ...(body.graph !== undefined && { graph: jsonValue(body.graph) }),
    },
  })
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
