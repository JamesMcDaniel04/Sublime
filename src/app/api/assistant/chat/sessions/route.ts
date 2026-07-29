import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** Lists the current user's Home assistant conversations, newest first. */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const sessions = await prisma.assistantChatSession.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })
  return {
    success: true,
    sessions: sessions
      .filter((session) => session._count.messages > 0)
      .map((session) => ({
        id: session.id,
        title: session.title || 'New chat',
        updatedAt: session.updatedAt.toISOString(),
        messageCount: session._count.messages,
      })),
  }
}, { requires: 'member' })
