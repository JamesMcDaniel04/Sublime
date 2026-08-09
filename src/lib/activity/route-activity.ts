/** Live activity → flow routing with database-backed idempotency. */
import { Prisma } from '@/generated/prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import type { PersistedActivity } from './ledger'

export type ActivityTriggerConfig = {
  type: 'activity'
  sources?: string[]
  actions?: string[]
  entityTypes?: string[]
  context?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const strArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')
    ? value as string[]
    : undefined

export function activityTriggerConfigOf(trigger: unknown): ActivityTriggerConfig | null {
  if (!isRecord(trigger) || trigger.type !== 'activity') return null
  const context = isRecord(trigger.context)
    ? Object.fromEntries(Object.entries(trigger.context).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    : undefined
  const sources = strArray(trigger.sources)
  const actions = strArray(trigger.actions)
  const entityTypes = strArray(trigger.entityTypes)
  return {
    type: 'activity',
    ...(sources ? { sources } : {}),
    ...(actions ? { actions } : {}),
    ...(entityTypes ? { entityTypes } : {}),
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
  }
}

export function matchActivityFlows(
  event: PersistedActivity,
  flows: { id: string; trigger: unknown }[],
): { id: string; config: ActivityTriggerConfig }[] {
  const matches: { id: string; config: ActivityTriggerConfig }[] = []
  for (const flow of flows) {
    const config = activityTriggerConfigOf(flow.trigger)
    if (!config) continue
    if (config.sources && !config.sources.includes(event.source)) continue
    if (config.actions && !config.actions.includes(event.action)) continue
    if (config.entityTypes && !config.entityTypes.includes(event.entityType)) continue
    if (config.context) {
      const context = event.businessContext ?? {}
      if (!Object.entries(config.context).every(([key, expected]) => String(context[key]) === expected)) continue
    }
    matches.push({ id: flow.id, config })
  }
  return matches
}

function activityRunTrigger(event: PersistedActivity) {
  return {
    type: 'activity' as const,
    activity: {
      eventId: event.id,
      source: event.source,
      action: event.action,
      entityType: event.entityType,
      entityRef: event.entityRef,
    },
  }
}

async function claimActivityTrigger(eventId: string, flowId: string): Promise<boolean> {
  try {
    await prisma.activityTriggerClaim.create({ data: { eventId, flowId } })
    return true
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
    throw error
  }
}

export async function routeActivityEvent(event: PersistedActivity): Promise<void> {
  if (event.ingestKind === 'backfill') return
  try {
    // Indexed narrowing on the denormalized columns: only published,
    // activity-triggered flows are loaded (trigger JSON only — no more
    // shipping every active flow's full publishedGraph per ingested event).
    const candidates = await systemPrisma.flow.findMany({
      where: { organizationId: event.organizationId, status: 'ACTIVE', triggerType: 'activity', isPublished: true },
      select: { id: true, userId: true, organizationId: true, trigger: true },
      take: 200,
    })
    for (const match of matchActivityFlows(event, candidates)) {
      const flow = candidates.find((candidate) => candidate.id === match.id)
      if (!flow || !(await claimActivityTrigger(event.id, flow.id))) continue
      try {
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: event.organizationId, isActive: true } })
          : await prisma.user.findFirst({
              where: { organizationId: event.organizationId, isActive: true },
              orderBy: { createdAt: 'asc' },
            })
        if (!owner) continue
        const trigger = activityRunTrigger(event)
        await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: event.organizationId,
          userId: owner.id,
          input: trigger.activity,
          usePublished: true,
          trigger,
        })
      } catch (error) {
        apiLogger.error('activity flow dispatch failed', {
          flowId: flow.id,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } catch (error) {
    apiLogger.warn('activity.routeActivityEvent failed', {
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
