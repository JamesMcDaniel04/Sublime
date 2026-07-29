/**
 * Goal scoping: which goal (or all of them) a request is looking through.
 *
 * The lens is a FILTER, never a grant. Scoped queries AND a contribution
 * filter onto the existing read scopes in visibility.ts, so a lens can only
 * remove rows from what the actor could already see. Fetching resources by
 * contribution id ALONE would bypass visibility entirely and show a
 * colleague's private flow because it happens to serve your goal — that shape
 * is forbidden, and asserted against in goal-lens-e2e.test.ts.
 *
 * Enforcement lives here rather than in pages: every app page is a
 * 'use client' component, so it can only pass the scope along on its fetches.
 * The API never trusts that parameter beyond using it as a lookup key.
 */

import { prisma } from '@/lib/prisma'
import { ApiError } from './api-handler'
import { can } from './permissions'
import type { AuthContext } from './auth'

/** The URL segment meaning "every goal". Not a valid goal id. */
export const ALL_SCOPE = 'all'

export type ResolvedGoal = { id: string; name: string; ownerUserId: string | null }

export type GoalScope =
  | { kind: 'all' }
  | { kind: 'goal'; goal: ResolvedGoal }

/**
 * 404, never 403: a goal the actor may not see must be indistinguishable from
 * one that does not exist.
 */
export class GoalScopeError extends ApiError {
  constructor(message = 'Goal not found') {
    super(message, 404, 'GOAL_NOT_FOUND')
  }
}

/**
 * Which goals an actor may read: org goals plus their own personal ones.
 *
 * Promoted from a private helper in api/goals/[id]/route.ts, which the goals
 * list route had already reimplemented inline. Restricted goals (Stage 2) add
 * a clause here, and a rule living in two files would only get it in one.
 */
export function goalReadWhere(userId: string): { OR: Array<Record<string, unknown>> } {
  return { OR: [{ ownerUserId: null }, { ownerUserId: userId }] }
}

/** Active goals in the workspace. Used by the <=1-goal exception below. */
async function activeGoalCount(organizationId: string): Promise<number> {
  return prisma.goal.count({ where: { organizationId, status: 'active' } })
}

/**
 * Turn a URL segment into a scope, refusing anything the actor may not have.
 *
 * A null/absent param means ALL — a client that simply omits ?goal= gets the
 * all-goals behaviour, which is itself gated, so omission is not a bypass.
 */
export async function resolveGoalScope(
  auth: AuthContext,
  scopeParam: string | null,
): Promise<GoalScope> {
  const scope = scopeParam?.trim() || ALL_SCOPE

  if (scope === ALL_SCOPE) {
    if (can(auth.actor, 'goal:read:all')) return { kind: 'all' }
    // A workspace with one goal (or none) has nothing to aggregate, so the
    // gate would lock people out of their own goals list rather than out of an
    // aggregate view. Without this an Individual workspace cannot reach the
    // page that creates its first goal.
    if (await activeGoalCount(auth.organizationId) <= 1) return { kind: 'all' }
    throw new ApiError(
      'Viewing every goal at once is part of the Team plan. Upgrade in Settings → Billing.',
      403,
      'PLAN_LIMIT',
    )
  }

  const goal = await prisma.goal.findFirst({
    where: { id: scope, organizationId: auth.organizationId, ...goalReadWhere(auth.dbUser.id) },
    select: { id: true, name: true, ownerUserId: true },
  })
  if (!goal) throw new GoalScopeError()
  return { kind: 'goal', goal }
}

/**
 * Resource ids contributing to a goal.
 *
 * GoalContribution stores resourceId as plain text with no FK (a contribution
 * outlives the row it points at), so this cannot be a Prisma relation filter —
 * callers get ids and AND them onto a read scope. Returning [] is meaningful:
 * `{ id: { in: [] } }` matches nothing, which is the correct empty lens.
 */
export async function contributionResourceIds(
  organizationId: string,
  goalId: string,
  resourceType: 'flow' | 'agent',
): Promise<string[]> {
  const rows = await prisma.goalContribution.findMany({
    where: { organizationId, goalId, resourceType },
    select: { resourceId: true },
  })
  return rows.map((row) => row.resourceId)
}
