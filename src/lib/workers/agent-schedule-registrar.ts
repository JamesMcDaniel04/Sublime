import type { Queue } from 'bullmq'
import { getQueue, getRedisConnection, QUEUE_NAMES } from '@/lib/queue/config'
import { prisma, systemPrisma } from '@/lib/prisma'

type Schedule = {
  type?: string
  time?: string
  cron?: string
  timezone?: string
  isActive?: boolean
}

type ScheduledAgent = {
  id: string
  schedule: unknown
  userId: string | null
  organizationId: string
  objective: string
}

type Candidate = { agent: ScheduledAgent; repeat: { pattern: string; tz: string } }

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

/** A null/malformed schedule is data, not a crash: return null so the row is
 *  skipped instead of aborting reconciliation for the whole fleet (which, at
 *  boot, restart-loops the worker). */
function scheduleOf(value: unknown): Schedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Schedule
}

function toCandidates(agents: ScheduledAgent[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const agent of agents) {
    const schedule = scheduleOf(agent.schedule)
    if (!schedule?.isActive) continue
    const repeat = repeatFor(schedule)
    if (!repeat) continue
    candidates.push({ agent, repeat })
  }
  return candidates
}

/**
 * Batched run-as resolution (previously up to 2 queries per agent, per tick):
 * the agent's owner when still active in the same org, else the org's oldest
 * active member (shared agents have no single owner).
 */
async function resolveRunAsUsers(candidates: Candidate[]) {
  const orgIds = [...new Set(candidates.map(({ agent }) => agent.organizationId))]
  const ownerIds = [...new Set(candidates.map(({ agent }) => agent.userId).filter((id): id is string => Boolean(id)))]
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds }, organizationId: { in: orgIds }, isActive: true },
        select: { id: true, organizationId: true },
      })
    : []
  const ownerById = new Map(owners.map((user) => [user.id, user]))
  const fallbacks = orgIds.length
    ? await prisma.user.findMany({
        where: { organizationId: { in: orgIds }, isActive: true },
        orderBy: { createdAt: 'asc' },
        distinct: ['organizationId'],
        select: { id: true, organizationId: true },
      })
    : []
  const fallbackByOrg = new Map(fallbacks.map((user) => [user.organizationId, user]))

  return (agent: ScheduledAgent) => {
    const owner = ownerById.get(agent.userId ?? '')
    if (owner?.organizationId === agent.organizationId) return owner
    return fallbackByOrg.get(agent.organizationId)
  }
}

const SCHEDULER_PAGE_SIZE = 500

/**
 * Remove schedulers whose agent is no longer active/scheduled — enumerated
 * from BullMQ rather than loading every inactive agent row forever. Collect
 * first, then remove: deleting while paginating shifts the pages.
 */
async function removeStaleSchedulers(queue: Queue, desired: Set<string>): Promise<number> {
  const stale: string[] = []
  for (let start = 0; ; start += SCHEDULER_PAGE_SIZE) {
    const schedulers = await queue.getJobSchedulers(start, start + SCHEDULER_PAGE_SIZE - 1)
    if (schedulers.length === 0) break
    for (const scheduler of schedulers) {
      const key = scheduler.key
      if (typeof key === 'string' && key.startsWith('agent:') && !desired.has(key)) stale.push(key)
    }
    if (schedulers.length < SCHEDULER_PAGE_SIZE) break
  }
  for (const key of stale) await queue.removeJobScheduler(key)
  return stale.length
}

const REGISTRAR_LOCK_KEY = 'locks:agent-schedule-registrar'

export async function registerAgentSchedules() {
  // Single-reconciler lock: with 2+ worker replicas, concurrent reconcilers
  // race removeJobScheduler against upsertJobScheduler for the same id and
  // flap schedules. TTL just under the 60s cadence so a crashed holder frees
  // itself before the next tick.
  const acquired = await getRedisConnection().set(REGISTRAR_LOCK_KEY, String(process.pid), 'PX', 55_000, 'NX')
  if (!acquired) return { registered: 0, failed: 0, removed: 0, skipped: true }

  // systemPrisma: worker scheduler reconciles ACTIVE agents across all orgs by design.
  const agents = await systemPrisma.agentTask.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, schedule: true, userId: true, organizationId: true, objective: true },
  })

  const candidates = toCandidates(agents)
  const runAsFor = await resolveRunAsUsers(candidates)
  const queue = getQueue(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION)

  // Every candidate is "desired" whether or not its upsert succeeds below — a
  // transient upsert failure must not get its existing scheduler removed.
  const desired = new Set(candidates.map(({ agent }) => `agent:${agent.id}`))

  let registered = 0
  let failed = 0
  for (const { agent, repeat } of candidates) {
    try {
      const user = runAsFor(agent)
      if (!user) continue
      await queue.upsertJobScheduler(`agent:${agent.id}`, repeat, {
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

  let removed = 0
  try {
    removed = await removeStaleSchedulers(queue, desired)
  } catch {
    failed += 1
  }

  return { registered, failed, removed }
}
