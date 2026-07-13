import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Notifications are personal. Null/org-wide rows are administrative legacy
// events and must not reveal another member's activity.
function scope(organizationId: string, userId: string) {
  return { organizationId, userId }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 30, 100)
  const where = scope(auth.organizationId, auth.dbUser.id)
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ])
  return { success: true, notifications, unread }
})
