import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Pending outbound-write approvals for this workspace.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const status = request.nextUrl.searchParams.get('status') || 'pending'
  const approvals = await prisma.approvalRequest.findMany({
    where: { organizationId: auth.organizationId, status },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, tool: true, summary: true, status: true, createdAt: true, executionId: true },
  })
  return { success: true, approvals }
})
