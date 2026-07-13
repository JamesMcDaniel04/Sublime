import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

// Flows are personal workspace content. Keep the legacy endpoint fail-closed
// so an older client cannot re-enable cross-user flow access.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  throw new ApiError('Flow sharing is disabled for personal workspace content', 403, 'PERSONAL_CONTENT')
})
