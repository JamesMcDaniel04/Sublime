import { Plan } from '@/generated/prisma/client'

/**
 * Per-plan usage limits. Every workspace is treated as an Individual account
 * (STARTER limits) unless it has purchased Team or Business. TRIAL is retained
 * as the database's legacy "no active subscription" sentinel; it does not
 * grant a free trial or access to paid product routes.
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
  /** Number of distinct non-general specialist areas the workspace may use. */
  maxSpecialistAreas: number
  /**
   * Active goals the workspace may hold. Counts ACTIVE goals only, so
   * archiving frees a slot. A downgrade never archives or deletes goals over
   * the cap — it only blocks creating new ones (see assertGoalCapacity).
   */
  maxActiveGoals: number
}

const INDIVIDUAL_LIMITS: PlanLimits = {
  label: 'Individual',
  seats: 1,
  monthlyCredits: 10_000,
  maxAgents: 5,
  maxFlows: 5,
  maxIntegrations: UNLIMITED,
  maxSpecialistAreas: 1,
  maxActiveGoals: 1,
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  // Unpaid legacy sentinel. Authentication's billing gate prevents product
  // access until checkout succeeds; these limits only shape plan previews.
  [Plan.TRIAL]: { ...INDIVIDUAL_LIMITS, label: 'Payment required' },
  [Plan.STARTER]: INDIVIDUAL_LIMITS,
  [Plan.PROFESSIONAL]: {
    label: 'Team',
    seats: 10,
    monthlyCredits: 50_000,
    maxAgents: 25,
    maxFlows: 25,
    maxIntegrations: UNLIMITED,
    maxSpecialistAreas: UNLIMITED,
    maxActiveGoals: 5,
  },
  [Plan.BUSINESS]: {
    label: 'Business',
    seats: 20,
    monthlyCredits: 200_000,
    maxAgents: UNLIMITED,
    maxFlows: UNLIMITED,
    maxIntegrations: UNLIMITED,
    maxSpecialistAreas: UNLIMITED,
    maxActiveGoals: 25,
  },
  [Plan.ENTERPRISE]: {
    label: 'Enterprise',
    seats: UNLIMITED,
    monthlyCredits: UNLIMITED,
    maxAgents: UNLIMITED,
    maxFlows: UNLIMITED,
    maxIntegrations: UNLIMITED,
    maxSpecialistAreas: UNLIMITED,
    maxActiveGoals: UNLIMITED,
  },
}

export function limitsForPlan(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan] ?? INDIVIDUAL_LIMITS
}

/**
 * Enterprise "custom" quotas: per-org overrides stored under
 * `organization.settings.customLimits` (set by internal tooling during
 * enterprise onboarding — deliberately NOT in the self-serve settings PATCH
 * allowlist). Only ENTERPRISE plans honor overrides, and only downward/finite
 * ones make sense there since the plan default is unlimited.
 */
const OVERRIDABLE_KEYS = ['seats', 'monthlyCredits', 'maxAgents', 'maxFlows', 'maxIntegrations', 'maxSpecialistAreas'] as const

export function limitsForOrg(plan: Plan, settings: unknown): PlanLimits {
  const base = limitsForPlan(plan)
  if (plan !== Plan.ENTERPRISE) return base
  const raw = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).customLimits
    : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base

  const overrides: Partial<PlanLimits> = {}
  for (const key of OVERRIDABLE_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      overrides[key] = Math.floor(value)
    }
  }
  return { ...base, ...overrides }
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
