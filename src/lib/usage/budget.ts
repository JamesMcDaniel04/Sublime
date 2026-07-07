import { prisma } from '@/lib/prisma'
import { cacheGetNumber, cacheIncrBy } from '@/lib/cache'

// Live month-to-date token counter, keyed per org + UTC month. Incremented per
// turn as tokens are spent, so concurrent runs/workers see each other's spend
// immediately (the DB columns are only written at run end). TTL just cleans up
// old months; the key rolls over each month.
const MONTH_TTL_MS = 35 * 24 * 60 * 60 * 1000
function monthKey(organizationId: string): string {
  const now = new Date()
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `usage:${organizationId}:${ym}`
}

/**
 * Record token spend against the live month-to-date counter. Call per turn.
 * Best-effort (returns the new total, or null if the counter backend is down).
 */
export async function recordTokenUsage(organizationId: string, tokens: number): Promise<number | null> {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  return cacheIncrBy(monthKey(organizationId), Math.floor(tokens), MONTH_TTL_MS)
}

/**
 * Per-entitlement-tier monthly token ceilings (total input+output per UTC
 * month). A workspace's tier comes from its People.ai entitlement snapshot
 * (Organization.entitlementTier). The env var AGENT_MONTHLY_TOKEN_LIMIT is a
 * global override/floor for environments without tiers.
 *
 * 0 means unlimited. Tune these as commercial tiers firm up.
 */
export const TIER_MONTHLY_TOKEN_LIMITS: Record<string, number> = {
  sales_ai: 20_000_000,
}

export function tokenLimitForTier(tier: string | null | undefined): number {
  const envLimit = Number(process.env.AGENT_MONTHLY_TOKEN_LIMIT) || 0
  const tierLimit = tier ? (TIER_MONTHLY_TOKEN_LIMITS[tier] ?? 0) : 0
  // If both are set, the more permissive ceiling wins (env acts as an override);
  // if only one is set, use it; if neither, unlimited.
  if (envLimit > 0 && tierLimit > 0) return Math.max(envLimit, tierLimit)
  return envLimit || tierLimit || 0
}

/**
 * Month-to-date token budget for an organization. Enforced at the start of every
 * agent run so a runaway agent (or an expired trial) can't burn unbounded spend.
 *
 * The ceiling is the workspace's entitlement-tier limit, overridable by
 * AGENT_MONTHLY_TOKEN_LIMIT. Unset/0 means unlimited — enforcement is opt-in.
 */
export async function checkMonthlyTokenBudget(
  organizationId: string,
): Promise<{ over: boolean; used: number; limit: number }> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { entitlementTier: true },
  })
  const limit = tokenLimitForTier(org?.entitlementTier)
  if (limit <= 0) return { over: false, used: 0, limit: 0 }

  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const aggregate = await prisma.agentExecution.aggregate({
    where: { organizationId, startedAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  })
  const dbUsed = (aggregate._sum.inputTokens || 0) + (aggregate._sum.outputTokens || 0)

  // The live counter includes in-flight runs the DB aggregate can't see yet, so
  // it's normally the higher (and correct) number. Fall back to the DB total if
  // the counter is unavailable or was reset mid-month, so we never under-count.
  const live = await cacheGetNumber(monthKey(organizationId))
  const used = Math.max(dbUsed, live ?? 0)

  return { over: used >= limit, used, limit }
}
