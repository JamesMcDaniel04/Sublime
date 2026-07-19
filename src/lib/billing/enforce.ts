import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { formatLimit, limitsForOrg, type PlanLimits } from './limits'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { departmentsForTools } from '@/lib/templates/departments'

/**
 * Plan-limit gates for resource creation. Each assert throws ApiError 403
 * PLAN_LIMIT with an upgrade-oriented message when the org is at capacity —
 * called from the create endpoints (agents, flows, integrations, seats).
 * Counts are checked at create time; existing resources over a downgraded
 * limit keep working (we never delete user work), they just can't add more.
 */

async function orgLimits(organizationId: string): Promise<PlanLimits> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { plan: true, settings: true },
  })
  return limitsForOrg(organization?.plan ?? 'TRIAL', organization?.settings)
}

function overLimitError(what: string, cap: number, planLabel: string): ApiError {
  return new ApiError(
    `Your ${planLabel} plan includes up to ${formatLimit(cap)} ${what}. Upgrade in Settings → Billing to add more.`,
    403,
    'PLAN_LIMIT',
  )
}

export async function assertAgentCapacity(organizationId: string): Promise<void> {
  const limits = await orgLimits(organizationId)
  if (!Number.isFinite(limits.maxAgents)) return
  const count = await prisma.agentTask.count({ where: { organizationId } })
  if (count >= limits.maxAgents) throw overLimitError('agents', limits.maxAgents, limits.label)
}

/**
 * Individual workspaces choose one durable area of focus. They may create any
 * number of agents within that area (subject to the agent cap), but cannot mix
 * Sales, Engineering, Marketing, Finance, or Customer Success specialists.
 * General/cross-functional helpers do not consume an area.
 */
export async function assertSpecialistAreaCapacity(
  organizationId: string,
  requestedArea: string | null | undefined,
  excludeAgentId?: string,
): Promise<void> {
  const normalized = requestedArea?.trim().toLowerCase() || 'general'
  if (normalized === 'general') return

  const limits = await orgLimits(organizationId)
  if (!Number.isFinite(limits.maxSpecialistAreas)) return

  const agents = await prisma.agentTask.findMany({
    where: {
      organizationId,
      status: { not: 'DELETED' },
      agentType: { not: 'SYSTEM' },
      ...(excludeAgentId ? { id: { not: excludeAgentId } } : {}),
    },
    select: { metadata: true },
  })
  const areas = new Set(
    agents
      .map((agent) => {
        const metadata = readAgentMetadata(agent.metadata)
        return (metadata.specialistArea || departmentsForTools(metadata.integrations ?? [])[0])?.trim().toLowerCase()
      })
      .filter((area): area is string => Boolean(area && area !== 'general')),
  )
  areas.add(normalized)
  if (areas.size > limits.maxSpecialistAreas) {
    throw new ApiError(
      `Your ${limits.label} plan includes one core specialist area. Keep this agent in ${Array.from(areas)[0]} or upgrade for every core area.`,
      403,
      'SPECIALIST_AREA_LIMIT',
    )
  }
}

export async function assertFlowCapacity(organizationId: string): Promise<void> {
  const limits = await orgLimits(organizationId)
  if (!Number.isFinite(limits.maxFlows)) return
  const count = await prisma.flow.count({ where: { organizationId } })
  if (count >= limits.maxFlows) throw overLimitError('flows', limits.maxFlows, limits.label)
}

export async function assertIntegrationCapacity(organizationId: string): Promise<void> {
  const limits = await orgLimits(organizationId)
  if (!Number.isFinite(limits.maxIntegrations)) return
  const [nango, mcp] = await Promise.all([
    prisma.nangoConnection.count({ where: { organizationId } }),
    prisma.mcpConnection.count({ where: { organizationId } }),
  ])
  if (nango + mcp >= limits.maxIntegrations) {
    throw overLimitError('connected integrations', limits.maxIntegrations, limits.label)
  }
}

export async function assertSeatCapacity(organizationId: string): Promise<void> {
  const limits = await orgLimits(organizationId)
  if (!Number.isFinite(limits.seats)) return
  // Pending invitations hold a seat until they expire — otherwise an org could
  // invite past its cap and let acceptance order decide who gets locked out.
  const [members, pendingInvitations] = await Promise.all([
    prisma.user.count({ where: { organizationId, isActive: true } }),
    prisma.organizationInvitation.count({
      where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ])
  if (members + pendingInvitations >= limits.seats) {
    throw overLimitError('seats', limits.seats, limits.label)
  }
}

/** Current usage snapshot for the billing UI. */
export async function orgUsageSummary(organizationId: string) {
  const [agents, flows, nango, mcp, members] = await Promise.all([
    prisma.agentTask.count({ where: { organizationId } }),
    prisma.flow.count({ where: { organizationId } }),
    prisma.nangoConnection.count({ where: { organizationId } }),
    prisma.mcpConnection.count({ where: { organizationId } }),
    prisma.user.count({ where: { organizationId, isActive: true } }),
  ])
  return { agents, flows, integrations: nango + mcp, members }
}
