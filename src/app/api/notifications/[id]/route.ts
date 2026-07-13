import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'

function embeddedProcesses(body: string | null): string[] {
  return (body ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('• ')).map((line) => line.slice(2).trim()).filter(Boolean)
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (!id) throw new ApiError('Notification id is required')
  const notification = await prisma.notification.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      OR: [{ userId: auth.dbUser.id }, { userId: null }],
    },
  })
  if (!notification) throw new ApiError('Notification not found', 404, 'NOT_FOUND')

  let processes = embeddedProcesses(notification.body)
  // Backfill detail for historical scan notifications whose body stored only
  // the count. The scan saved one learning memory per process immediately
  // before creating the notification, so these are the durable source detail.
  if (notification.type === 'intelligence.scan' && processes.length === 0) {
    const agentId = await findOrgIntelligenceAgentId(auth.organizationId)
    if (agentId) {
      const memories = await prisma.agentMemory.findMany({
        where: {
          organizationId: auth.organizationId,
          agentId,
          kind: 'learning',
          status: 'open',
          title: { startsWith: `How we use ${notification.title}:` },
          createdAt: { lte: notification.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { content: true },
      })
      processes = memories.map((memory) => memory.content).filter(Boolean)
    }
  }

  return {
    success: true,
    notification: {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body?.split('\n')[0] ?? null,
      createdAt: notification.createdAt,
    },
    processes,
  }
})
