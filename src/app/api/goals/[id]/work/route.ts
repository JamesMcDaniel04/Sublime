import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { computeWorkStats } from '@/lib/goals/work-stats'
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'
import { getSeedByKey } from '@/lib/templates/catalogue'

export const runtime = 'nodejs'

const FILTERS = ['mine', 'unassigned', 'all', 'done'] as const
type Filter = (typeof FILTERS)[number]

const PAGE = 100

/** pathname: /api/goals/<id>/work */
const goalIdFrom = (pathname: string) => decodeURIComponent(pathname.split('/').at(-2) ?? '')

/**
 * The workroom's queue.
 *
 * `items` respects the chosen filter; `stats` never does. A funnel that
 * changed every time you clicked a tab would be unreadable — the whole point
 * of the number is that it describes the goal, not the current view.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)
  const raw = request.nextUrl.searchParams.get('filter') ?? 'mine'
  const filter: Filter = (FILTERS as readonly string[]).includes(raw) ? (raw as Filter) : 'mine'

  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const open = { disposition: 'pending' as const }
  const scope = { organizationId: auth.organizationId, goalId }

  // 'done' is the only filter that looks past open work; the rest narrow the
  // pending queue by who owns it.
  const WHERE_BY_FILTER: Record<Filter, Record<string, unknown>> = {
    mine: { ...scope, ...open, assigneeUserId: auth.dbUser.id },
    unassigned: { ...scope, ...open, assigneeUserId: null },
    all: { ...scope, ...open },
    done: { ...scope, disposition: { in: ['used', 'edited', 'skipped'] } },
  }
  const where = WHERE_BY_FILTER[filter]

  const items = await prisma.goalWork.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: PAGE,
  })

  const all = await prisma.goalWork.findMany({
    where: scope,
    select: { resourceId: true, disposition: true, outcome: true },
  })

  // The human name for an agent comes from the seed it was deployed from —
  // AgentTask carries a description and an objective, not a name, so the
  // contribution's seedKey is the only source of a label a person recognizes.
  const contributions = await prisma.goalContribution.findMany({
    where: { organizationId: auth.organizationId, goalId },
    select: { resourceId: true, seedKey: true },
  })
  const seedKeyByResource = new Map(
    contributions.map((row) => [row.resourceId, row.seedKey] as const),
  )
  const nameFor = (resourceId: string) => {
    const seedKey = seedKeyByResource.get(resourceId)
    const seed = seedKey ? getSeedByKey(seedKey) : undefined
    return seed?.name ?? 'Removed agent'
  }

  const stats = computeWorkStats(
    all.map((row) => ({
      resourceId: row.resourceId,
      resourceName: nameFor(row.resourceId),
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  )

  // The viewer's id rides along so the queue can offer Claim without a
  // separate /api/me round trip or a prop threaded down the goal page.
  return { items, stats, viewerId: auth.dbUser.id }
})
