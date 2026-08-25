import { prisma } from '@/lib/prisma'
import { withPublicApi } from '@/lib/server/public-api-handler'

/**
 * GET /api/v1/flows — the flows in the key's workspace.
 *
 * Returns the flow's identity and status only. A flow's GRAPH is deliberately
 * not here: it carries node configuration, and a `flows:read` key is for
 * finding something to run, not for exporting the workspace's automation.
 */
export const GET = withPublicApi(async (request, context) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? 50) || 50, 100)
  const flows = await prisma.flow.findMany({
    where: { organizationId: context.organizationId },
    select: { id: true, name: true, description: true, status: true, isPublished: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  })
  return { success: true, flows }
}, { scope: 'flows:read' })
