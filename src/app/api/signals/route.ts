import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Recent inbound People.ai signals that triggered this user's runs.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 50, 100)
  const signals = await prisma.signal.findMany({
    where: {
      organizationId: auth.organizationId,
      subscriptionRuns: { some: { userId: auth.dbUser.id } },
    },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      type: true,
      accountId: true,
      opportunityId: true,
      stakeholderId: true,
      provenanceUrl: true,
      receivedAt: true,
      processedAt: true,
      _count: { select: { subscriptionRuns: { where: { userId: auth.dbUser.id } } } },
    },
  })
  return { success: true, signals }
})
