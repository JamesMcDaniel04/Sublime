import { createQueue, QUEUE_NAMES } from '@/lib/queue/config'
import { prisma } from '@/lib/prisma'

type Schedule = {
  type?: string
  time?: string
  cron?: string
  timezone?: string
  isActive?: boolean
}

function repeatFor(schedule: Schedule) {
  const timezone = schedule.timezone || 'UTC'
  if (schedule.type === 'cron' && schedule.cron) return { pattern: schedule.cron, tz: timezone }
  if (schedule.type === 'hourly') return { pattern: '0 * * * *', tz: timezone }
  if (schedule.type === 'daily' || schedule.type === 'weekly') {
    const [hour = '9', minute = '0'] = String(schedule.time || '09:00').split(':')
    const day = schedule.type === 'weekly' ? '1' : '*'
    return { pattern: `${Number(minute)} ${Number(hour)} * * ${day}`, tz: timezone }
  }
  return null
}

export async function registerAgentSchedules() {
  const agents = await prisma.agentTask.findMany()
  const queue = createQueue(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION)
  let registered = 0
  let failed = 0

  try {
    for (const agent of agents) {
      const schedulerId = `agent:${agent.id}`
      const schedule = agent.schedule as Schedule
      const repeat = agent.status === 'ACTIVE' && schedule.isActive ? repeatFor(schedule) : null

      try {
        if (!repeat) {
          await queue.removeJobScheduler(schedulerId)
          continue
        }

        // Scheduled runs execute as the agent's owner when set; otherwise as the
        // org's oldest active member (shared agents have no single owner).
        const owner = agent.userId
          ? await prisma.user.findFirst({
              where: { id: agent.userId, organizationId: agent.organizationId, isActive: true },
            })
          : null
        const user =
          owner ||
          (await prisma.user.findFirst({
            where: { organizationId: agent.organizationId, isActive: true },
            orderBy: { createdAt: 'asc' },
          }))
        if (!user) continue

        await queue.upsertJobScheduler(schedulerId, repeat, {
          name: 'execute-scheduled-agent',
          data: {
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId: user.id,
            input: agent.objective,
          },
        })
        registered += 1
      } catch {
        // An invalid cron expression on one agent must not break reconciliation
        // for the rest of the fleet.
        failed += 1
      }
    }
  } finally {
    await queue.close()
  }

  return { registered, failed }
}
