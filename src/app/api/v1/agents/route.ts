import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'

/** GET /api/v1/agents — the agents in the key's workspace. */
export const GET = withPublicApi(async (request, context) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? 50) || 50, 100)
  const agents = await prisma.agentTask.findMany({
    where: { organizationId: context.organizationId },
    select: { id: true, description: true, objective: true, status: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return { success: true, agents }
}, { scope: 'agents:read' })
