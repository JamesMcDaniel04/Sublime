import { Plan } from '@prisma/client'

export type SupportTier = 'resources' | 'priority' | 'dedicated'

export type PlanCapabilities = {
  unlimitedKnowledge: true
  unlimitedConnectedTools: true
  liveKnowledgeSync: true
  automatedWorkflows: true
  additionalUsageAvailable: true
  specialistAreas: 'one' | 'every' | 'custom'
  skillSharing: 'private' | 'controlled'
  activityHistory: true
  zeroDataRetention: boolean
  support: SupportTier
}

/** Product entitlements that are not simple numeric resource caps. */
export function capabilitiesForPlan(plan: Plan): PlanCapabilities {
  if (plan === Plan.ENTERPRISE) {
    return {
      unlimitedKnowledge: true,
      unlimitedConnectedTools: true,
      liveKnowledgeSync: true,
      automatedWorkflows: true,
      additionalUsageAvailable: true,
      specialistAreas: 'custom',
      skillSharing: 'controlled',
      activityHistory: true,
      zeroDataRetention: true,
      support: 'dedicated',
    }
  }
  const team = plan === Plan.PROFESSIONAL || plan === Plan.BUSINESS
  return {
    unlimitedKnowledge: true,
    unlimitedConnectedTools: true,
    liveKnowledgeSync: true,
    automatedWorkflows: true,
    additionalUsageAvailable: true,
    specialistAreas: team ? 'every' : 'one',
    skillSharing: team ? 'controlled' : 'private',
    activityHistory: true,
    zeroDataRetention: false,
    support: team ? 'priority' : 'resources',
  }
}
