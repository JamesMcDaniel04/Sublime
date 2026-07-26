import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { goalImpact } from '@/lib/goals/impact'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { agentReadScope, flowReadScope } from '@/lib/server/visibility'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const goalIdFrom = (pathname: string) =>
  decodeURIComponent(pathname.split('/').at(-2) ?? '')

async function requireGoal(
  organizationId: string,
  userId: string,
  goalId: string,
) {
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId,
      OR: [{ ownerUserId: null }, { ownerUserId: userId }],
    },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  return goal
}

async function contributionView(
  organizationId: string,
  userId: string,
  contribution: {
    id: string
    resourceType: string
    resourceId: string
    origin: string
    estimatedMinutesSavedPerRun: number
    createdAt: Date
  },
) {
  if (contribution.resourceType === 'flow') {
    const flow = await prisma.flow.findFirst({
      where: {
        id: contribution.resourceId,
        organizationId,
        ...flowReadScope(userId),
      },
      select: { name: true },
    })
    const runs = flow
      ? await prisma.flowRun.count({
          where: {
            organizationId,
            flowId: contribution.resourceId,
            status: 'succeeded',
            startedAt: { gt: contribution.createdAt },
          },
        })
      : 0
    return { ...contribution, name: flow?.name ?? 'Private automation', runs, tokens: 0 }
  }

  const agent = await prisma.agentTask.findFirst({
    where: {
      id: contribution.resourceId,
      organizationId,
      status: { not: 'DELETED' },
      ...agentReadScope(userId),
    },
    select: { description: true, metadata: true },
  })
  const executions = agent
    ? await prisma.agentExecution.findMany({
        where: {
          organizationId,
          agentTaskId: contribution.resourceId,
          completedAt: { not: null },
          error: null,
          startedAt: { gt: contribution.createdAt },
        },
        select: { inputTokens: true, outputTokens: true },
      })
    : []
  const metadata = agent ? readAgentMetadata(agent.metadata) : null
  return {
    ...contribution,
    name: metadata?.title || agent?.description || 'Private automation',
    runs: executions.length,
    tokens: executions.reduce(
      (sum, execution) => sum + execution.inputTokens + execution.outputTokens,
      0,
    ),
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)
  await requireGoal(auth.organizationId, auth.dbUser.id, goalId)
  const rows = await prisma.goalContribution.findMany({
    where: { organizationId: auth.organizationId, goalId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      resourceType: true,
      resourceId: true,
      origin: true,
      estimatedMinutesSavedPerRun: true,
      createdAt: true,
    },
  })
  const [contributions, impact] = await Promise.all([
    Promise.all(
      rows.map((contribution) =>
        contributionView(auth.organizationId, auth.dbUser.id, contribution),
      ),
    ),
    goalImpact(auth.organizationId, goalId),
  ])
  return { success: true, contributions, impact }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)
  await requireGoal(auth.organizationId, auth.dbUser.id, goalId)
  const input = z
    .object({
      resourceType: z.enum(['flow', 'agent']),
      resourceId: z.string().min(1),
      estimatedMinutesSavedPerRun: z.number().int().positive().max(1440).default(30),
    })
    .parse(await request.json().catch(() => ({})))

  const exists =
    input.resourceType === 'flow'
      ? await prisma.flow.findFirst({
          where: {
            id: input.resourceId,
            organizationId: auth.organizationId,
            ...flowReadScope(auth.dbUser.id),
          },
          select: { id: true },
        })
      : await prisma.agentTask.findFirst({
          where: {
            id: input.resourceId,
            organizationId: auth.organizationId,
            status: { not: 'DELETED' },
            ...agentReadScope(auth.dbUser.id),
          },
          select: { id: true },
        })
  if (!exists) throw new ApiError('Automation not found', 404, 'RESOURCE_NOT_FOUND')

  let contribution: { id: string }
  try {
    contribution = await prisma.goalContribution.create({
      data: {
        organizationId: auth.organizationId,
        goalId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        origin: 'manual',
        estimatedMinutesSavedPerRun: input.estimatedMinutesSavedPerRun,
      },
      select: { id: true },
    })
  } catch (error) {
    // Only the create's unique violation means "already linked" — the event
    // write below must never be misreported as a duplicate.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError('Already linked', 409, 'DUPLICATE_LINK')
    }
    throw error
  }
  await recordUserEvent({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    kind: 'goal_contribution_linked',
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    context: { goalId, origin: 'manual' },
  })
  return { success: true, contribution }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)
  await requireGoal(auth.organizationId, auth.dbUser.id, goalId)
  const contributionId = request.nextUrl.searchParams.get('contributionId') ?? ''
  if (!contributionId) throw new ApiError('Contribution id is required', 400, 'MISSING_CONTRIBUTION_ID')
  const deleted = await prisma.goalContribution.deleteMany({
    where: {
      id: contributionId,
      goalId,
      organizationId: auth.organizationId,
    },
  })
  if (deleted.count === 0) {
    throw new ApiError('Contribution not found', 404, 'CONTRIBUTION_NOT_FOUND')
  }
  return { success: true }
})
