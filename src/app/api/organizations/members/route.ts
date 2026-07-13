import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

// GET /api/organizations/members — active members of the caller's org, for
// pickers (e.g. inviting teammates to a Flow Jam).
export const GET = withAuthenticatedApi(async (_request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  return {
    success: true,
    members: members.map((member) => ({
      id: member.id,
      name: member.name || member.email || 'Member',
      email: member.email,
      isSelf: member.id === auth.dbUser.id,
    })),
  }
})
