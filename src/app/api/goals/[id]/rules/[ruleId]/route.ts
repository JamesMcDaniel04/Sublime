import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** pathname: /api/goals/<goalId>/rules/<ruleId> */
const idsFrom = (pathname: string) => {
  const segments = pathname.split('/')
  return {
    ruleId: decodeURIComponent(segments.at(-1) ?? ''),
    goalId: decodeURIComponent(segments.at(-3) ?? ''),
  }
}

/**
 * Turn off a learned rule.
 *
 * Retires rather than deletes: the rule and its evidence stay readable as
 * history, and its probes stay attached to something. `revoked` is a distinct
 * retirement reason so a rule a person deliberately turned off is never
 * confused with one the evidence killed.
 *
 * Revocation is not the lifecycle — probes and the unprobed TTL are. This
 * exists so a human who can see an inference is wrong does not have to wait
 * for the evidence to catch up.
 */
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { goalId, ruleId } = idsFrom(request.nextUrl.pathname)

  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')

  const rule = await prisma.goalWorkRule.findFirst({
    where: { id: ruleId, organizationId: auth.organizationId, status: 'active' },
    select: { id: true },
  })
  if (!rule) throw new ApiError('Rule not found', 404, 'RULE_NOT_FOUND')

  await prisma.goalWorkRule.updateMany({
    where: { id: rule.id, organizationId: auth.organizationId },
    data: {
      status: 'retired',
      retiredAt: new Date(),
      retiredReason: 'revoked',
      revokedByUserId: auth.dbUser.id,
    },
  })

  return { ok: true }
}, { requires: 'member' })
