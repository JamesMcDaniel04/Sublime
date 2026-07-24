import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

// GET/PUT/DELETE /api/flows/[id]/pins — per-user pinned node outputs, the
// dev-time fixtures single-node testing resolves input from. Pins are working
// state, not flow definition: they live in their own table (never in
// Flow.graph), are scoped to the caller, and a shared flow's pins do not
// travel between users.

const flowIdFrom = (pathname: string) => pathname.split('/').at(-2)

/** Pins hang off a flow the caller can read; 404 keeps cross-org ids blind. */
async function readableFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...flowReadScope(userId) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const pins = await prisma.flowNodePin.findMany({
    where: { flowId: id, organizationId: auth.organizationId, userId: auth.dbUser.id },
    select: { nodeId: true, output: true, updatedAt: true },
  })
  return { success: true, pins }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const { nodeId, output } = z
    .object({ nodeId: z.string().min(1), output: z.unknown() })
    .parse(await request.json().catch(() => ({})))
  const pin = await prisma.flowNodePin.upsert({
    // organizationId alongside the unique key: tenant-guard requires org scope
    // on every org-model query (extended unique-where accepts the extra field).
    where: { flowId_nodeId_userId: { flowId: id, nodeId, userId: auth.dbUser.id }, organizationId: auth.organizationId },
    create: { flowId: id, nodeId, userId: auth.dbUser.id, organizationId: auth.organizationId, output: (output ?? null) as never },
    update: { output: (output ?? null) as never },
    select: { nodeId: true, output: true, updatedAt: true },
  })
  return { success: true, pin }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = flowIdFrom(request.nextUrl.pathname)
  if (!id) throw new ApiError('Flow id is required')
  await readableFlow(id, auth.organizationId, auth.dbUser.id)
  const { nodeId } = z.object({ nodeId: z.string().min(1) }).parse(await request.json().catch(() => ({})))
  await prisma.flowNodePin.deleteMany({
    where: { flowId: id, nodeId, userId: auth.dbUser.id, organizationId: auth.organizationId },
  })
  return { success: true }
})
