import { prisma } from '@/lib/prisma'
import { sendPushToUser } from './push'

export type NotificationLevel = 'info' | 'success' | 'error' | 'action'

type NotifyInput = {
  organizationId: string
  userId?: string | null
  type: string
  level?: NotificationLevel
  title: string
  body?: string
  agentTaskId?: string
  executionId?: string
}

// Creates an in-app notification and fires a best-effort web push. Never throws
// into the caller — notification failures must not break an agent run.
export async function notify(input: NotifyInput) {
  try {
    const notification = await prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        type: input.type,
        level: input.level ?? 'info',
        title: input.title,
        body: input.body?.slice(0, 2000),
        agentTaskId: input.agentTaskId,
        executionId: input.executionId,
      },
    })
    if (input.userId) {
      void sendPushToUser(input.userId, {
        title: input.title,
        body: input.body,
        url: input.executionId ? `/dashboard?run=${input.executionId}` : '/dashboard',
      }).catch(() => {})
    }
    return notification
  } catch {
    return null
  }
}
