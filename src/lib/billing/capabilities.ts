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
  /** Workspace activity-history feed — Team plans and above. */
  activityHistory: boolean
  /**
   * The cross-goal ("All goals") lens: the aggregated view and roll-up
   * insights spanning every goal. Team plans and above. Individual workspaces
   * may still hold goals (up to PlanLimits.maxActiveGoals) and lens into each
   * one — they just don't get the view that spans them.
   */
  allGoalsView: boolean
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
      allGoalsView: true,
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
    activityHistory: team,
    allGoalsView: team,
    zeroDataRetention: false,
    support: team ? 'priority' : 'resources',
  }
}
