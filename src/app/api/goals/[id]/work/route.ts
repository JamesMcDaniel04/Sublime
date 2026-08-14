import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { computeWorkStats } from '@/lib/goals/work-stats'
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'
import { getSeedByKey } from '@/lib/templates/catalogue'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { serializeWorkForNonMember } from '@/lib/goals/work-serializer'
import { memberDisplayName } from '@/lib/server/member-display'

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

  // Visibility-scoped, not merely org-scoped. This previously checked only
  // organizationId, which let any member read the work queue of a colleague's
  // PERSONAL goal by guessing its id.
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId: auth.organizationId,
      ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }),
    },
    select: { id: true },
  })

  if (!goal) {
    // Not a member of a restricted goal. They keep work ALREADY ASSIGNED to
    // them so they can finish it — anonymised, and only their own rows.
    const assigned = await prisma.goalWork.findMany({
      where: { organizationId: auth.organizationId, goalId, assigneeUserId: auth.dbUser.id },
      orderBy: { createdAt: 'desc' },
      take: PAGE,
    })
    // No rows means the goal is, as far as this actor is concerned, absent —
    // and absent is a 404, never a 403.
    if (!assigned.length) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
    return {
      success: true,
      items: assigned.map(serializeWorkForNonMember),
      // No stats: the funnel is a property OF THE GOAL, so publishing it would
      // leak exactly what hiding the goal was meant to withhold.
      stats: null,
      anonymised: true,
    }
  }

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
    select: { resourceId: true, disposition: true, outcome: true, assigneeUserId: true },
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

  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId },
    select: { id: true, name: true, email: true },
  })
  const memberName = new Map(
    members.map((member) => [member.id, memberDisplayName(member)] as const),
  )

  const stats = computeWorkStats(
    all.map((row) => ({
      resourceId: row.resourceId,
      resourceName: nameFor(row.resourceId),
      assigneeUserId: row.assigneeUserId,
      // A departed teammate still owns their history; degrade rather than throw.
      assigneeName: row.assigneeUserId
        ? (memberName.get(row.assigneeUserId) ?? 'Former teammate')
        : 'Unassigned',
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  )

  // Every active rule steering work on this goal, across agents. Rules change
  // what agents produce; a person must be able to see the inference and the
  // evidence behind it, and turn one off. Returned here rather than from a
  // second endpoint so the workroom stays one round trip.
  const ruleRows = await prisma.goalWorkRule.findMany({
    where: {
      organizationId: auth.organizationId,
      status: 'active',
      OR: [
        { goalId },
        // Seed-level rules apply to this goal through whichever of its agents
        // came from that seed.
        { goalId: null, seedKey: { in: [...new Set(contributions.map((row) => row.seedKey).filter(Boolean) as string[])] } },
      ],
    },
    orderBy: { learnedAt: 'desc' },
  })

  const rules = ruleRows.map((rule) => ({
    id: rule.id,
    statement: rule.statement,
    signal: rule.signal,
    skippedCount: rule.skippedCount,
    totalCount: rule.totalCount,
    finding: rule.finding,
    topSkipReason: rule.topSkipReason,
    exploreRate: rule.exploreRate,
    learnedAt: rule.learnedAt,
    scope: rule.goalId ? ('agent' as const) : ('org' as const),
    agentName: rule.resourceId ? nameFor(rule.resourceId) : null,
  }))

  // Verbatim feedback on the playbook. Capped: this is a signal, not an inbox.
  const noteRows = await prisma.goalWork.findMany({
    where: { organizationId: auth.organizationId, goalId, skipNote: { not: null } },
    orderBy: { dispositionAt: 'desc' },
    take: 5,
    select: { subject: true, skipNote: true },
  })
  const skipNotes = noteRows.map((row) => ({ subject: row.subject, note: row.skipNote! }))

  // Which front door to open. The person with no work assigned is the person
  // watching the process, so they get adoption first. Deliberately derived
  // rather than read from UserRole, which is ADMIN|USER — a permissions
  // concept, not a job function.
  const openForViewer = await prisma.goalWork.count({
    where: {
      organizationId: auth.organizationId,
      goalId,
      assigneeUserId: auth.dbUser.id,
      disposition: 'pending',
    },
  })

  // The viewer's id rides along so the queue can offer Claim without a
  // separate /api/me round trip or a prop threaded down the goal page.
  return {
    items,
    stats,
    rules,
    skipNotes,
    viewerId: auth.dbUser.id,
    viewerHasWork: openForViewer > 0,
  }
}, { requires: 'member' })
