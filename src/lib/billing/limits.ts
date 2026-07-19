import { Plan } from '@prisma/client'

/**
 * Per-plan usage limits. Every workspace is treated as an Individual account
 * (STARTER limits) unless it has purchased Team or Business — including TRIAL
 * workspaces, which get Individual-shaped limits while they evaluate.
 *
 * Credits: 1 credit = 1,000 model tokens (input + output combined). The
 * monthly credit allowance is an ORG-wide pool, not per seat.
 */
export const TOKENS_PER_CREDIT = 1_000

export const UNLIMITED = Number.POSITIVE_INFINITY

export type PlanLimits = {
  label: string
  seats: number
  monthlyCredits: number
  maxAgents: number
  maxFlows: number
  maxIntegrations: number
}

const INDIVIDUAL_LIMITS: PlanLimits = {
  label: 'Individual',
  seats: 1,
  monthlyCredits: 10_000,
  maxAgents: 5,
  maxFlows: 5,
  maxIntegrations: 5,
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  // Trials evaluate under Individual limits — nobody gets more than the base
  // tier without paying for it.
  [Plan.TRIAL]: { ...INDIVIDUAL_LIMITS, label: 'Trial' },
  [Plan.STARTER]: INDIVIDUAL_LIMITS,
  [Plan.PROFESSIONAL]: {
    label: 'Team',
    seats: 5,
    monthlyCredits: 50_000,
    maxAgents: 25,
    maxFlows: 25,
    maxIntegrations: UNLIMITED,
  },
  [Plan.BUSINESS]: {
    label: 'Business',
    seats: 25,
    monthlyCredits: 250_000,
    maxAgents: UNLIMITED,
    maxFlows: UNLIMITED,
    maxIntegrations: UNLIMITED,
  },
  [Plan.ENTERPRISE]: {
    label: 'Enterprise',
    seats: UNLIMITED,
    monthlyCredits: UNLIMITED,
    maxAgents: UNLIMITED,
    maxFlows: UNLIMITED,
    maxIntegrations: UNLIMITED,
  },
}

export function limitsForPlan(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan] ?? INDIVIDUAL_LIMITS
}

/** Monthly token allowance for a plan; Infinity when the plan is unlimited. */
export function monthlyTokenAllowance(plan: Plan): number {
  const credits = limitsForPlan(plan).monthlyCredits
  return Number.isFinite(credits) ? credits * TOKENS_PER_CREDIT : UNLIMITED
}

/** Tokens → whole credits (rounded up), for display. */
export function tokensToCredits(tokens: number): number {
  return Math.ceil(Math.max(0, tokens) / TOKENS_PER_CREDIT)
}

/** Human-readable cap: "5" or "Unlimited". */
export function formatLimit(value: number): string {
  return Number.isFinite(value) ? String(value) : 'Unlimited'
}
