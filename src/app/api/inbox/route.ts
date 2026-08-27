import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope, flowReadScope } from '@/lib/server/visibility'
import { deriveRunWaiting } from '@/lib/flows/run-waiting'
import { shapeNeedsYou } from '@/lib/inbox/needs-you'

export const runtime = 'nodejs'

/** Per source. The bell shows a handful; nobody triages 200 items in a popover. */
const PER_SOURCE = 25

/**
 * GET /api/inbox — everything waiting on THIS person, oldest first.
 *
 * Each source is scoped to what the caller can act on: their own runs (a
 * reply resumes a run with the requester's credentials, so nobody else's run
 * is theirs to answer), flows they can read, work assigned to them, and
 * recommendations addressed to them.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const userId = auth.dbUser.id

  const [executions, flowRuns, work, goalActions] = await Promise.all([
    prisma.agentExecution.findMany({
      where: { organizationId, status: 'waiting_for_input', ...executionVisibilityScope(userId) },
      orderBy: { startedAt: 'asc' },
      take: PER_SOURCE,
      select: { id: true, startedAt: true, metadata: true, agentTask: { select: { id: true, description: true, metadata: true } } },
    }),
    prisma.flowRun.findMany({
      where: { organizationId, status: 'waiting', flow: flowReadScope(userId) },
      orderBy: { startedAt: 'asc' },
      take: PER_SOURCE,
      select: {
        id: true, flowId: true, startedAt: true,
        flow: { select: { name: true } },
        steps: { orderBy: { order: 'asc' }, take: 500, select: { nodeId: true, status: true, output: true } },
      },
    }),
    prisma.goalWork.findMany({
      where: { organizationId, disposition: 'pending', assigneeUserId: userId },
      orderBy: { createdAt: 'asc' },
      take: PER_SOURCE,
      select: { id: true, goalId: true, subject: true, produced: true, createdAt: true, goal: { select: { name: true } } },
    }),
    prisma.userSuggestion.findMany({
      where: { organizationId, userId, kind: 'goal_action', status: 'open' },
      orderBy: { createdAt: 'asc' },
      take: PER_SOURCE,
      select: { id: true, title: true, description: true, targetId: true, createdAt: true },
    }),
  ])

  const items = shapeNeedsYou({
    executions,
    flowRuns: flowRuns.map((run) => ({
      id: run.id, flowId: run.flowId, startedAt: run.startedAt, flow: run.flow,
      waiting: deriveRunWaiting('waiting', run.steps),
    })),
    work,
    goalActions,
  })
  return { success: true, items, count: items.length }
}, { requires: 'member' })
