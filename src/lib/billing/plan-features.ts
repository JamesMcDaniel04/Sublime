import type { Plan } from '@/generated/prisma/client'
import { PLAN_LIMITS, UNLIMITED } from '@/lib/billing/limits'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'

/**
 * What a plan includes, derived from the limits and capabilities the app
 * actually enforces.
 *
 * The pricing grid used to be a hardcoded list of bullets that read neither —
 * so the page could advertise "5 agents" while the enforcer allowed a different
 * number, and nothing failed when they drifted. Deriving the copy makes the
 * limit the single source of truth: change the cap and the marketing follows.
 */

const count = (value: number): string => (value === UNLIMITED ? 'Unlimited' : value.toLocaleString('en-US'))

export function planFeatureBullets(plan: Plan): string[] {
  const limits = PLAN_LIMITS[plan]
  const capabilities = capabilitiesForPlan(plan)
  const bullets: string[] = []

  bullets.push(
    limits.seats === UNLIMITED
      ? 'Unlimited seats'
      : `${limits.seats} ${limits.seats === 1 ? 'seat' : 'seats'} included`,
  )

  bullets.push(
    limits.monthlyCredits === UNLIMITED
      ? 'Unlimited monthly credits'
      : `${count(limits.monthlyCredits)} credits / month`,
  )

  // Agents and flows share a cap shape, so they share a bullet.
  bullets.push(
    limits.maxAgents === UNLIMITED && limits.maxFlows === UNLIMITED
      ? 'Unlimited agents & flows'
      : `${count(limits.maxAgents)} agents · ${count(limits.maxFlows)} flows`,
  )

  bullets.push(
    capabilities.specialistAreas === 'one'
      ? '1 core specialist area'
      : capabilities.specialistAreas === 'custom'
        ? 'Custom specialist areas'
        : 'Every core specialist area',
  )

  if (capabilities.unlimitedKnowledge && capabilities.unlimitedConnectedTools) {
    bullets.push('Unlimited knowledge & connections')
  }

  // Entitlements, phrased as what the workspace gets rather than as flag names.
  const gated = [
    capabilities.liveKnowledgeSync ? 'knowledge sync' : null,
    capabilities.skillSharing === 'controlled' ? 'sharing' : null,
    capabilities.activityHistory ? 'activity history' : null,
  ].filter((entry): entry is string => entry !== null)
  if (gated.length > 1) {
    bullets.push(`${gated[0][0].toUpperCase()}${gated[0].slice(1)}, ${gated.slice(1).join(' & ')}`)
  }

  if (capabilities.allGoalsView) bullets.push('Cross-goal roll-up view')
  if (capabilities.zeroDataRetention) bullets.push('Zero data retention')

  bullets.push(
    capabilities.support === 'dedicated'
      ? 'Dedicated support'
      : capabilities.support === 'priority'
        ? 'Priority support'
        : 'Support resources',
  )

  return bullets
}
