import { Plan } from '@prisma/client'

/** Every new workspace gets this many days of full access before a card is required. */
export const TRIAL_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

type BillingFields = {
  plan: Plan
  trialEndsAt: Date | null
  createdAt: Date
}

export function newTrialEnd(from: Date = new Date()): Date {
  return new Date(from.getTime() + TRIAL_DAYS * DAY_MS)
}

/** Orgs provisioned before the trialEndsAt column existed fall back to signup + 14d. */
export function trialEndFor(org: Pick<BillingFields, 'trialEndsAt' | 'createdAt'>): Date {
  return org.trialEndsAt ?? newTrialEnd(org.createdAt)
}

export type BillingState =
  | { state: 'paid'; plan: Plan }
  | { state: 'trialing'; plan: Plan; trialEndsAt: Date; daysLeft: number }
  | { state: 'expired'; plan: Plan; trialEndsAt: Date }

/**
 * The single billing-access rule: a paid plan is always in; a TRIAL org is in
 * until its deadline and locked after. Webhook downgrades set plan back to
 * TRIAL, so a subscription canceled mid-trial re-enters 'trialing' for the
 * remainder of the original 14 days, then locks.
 */
export function billingStateFor(org: BillingFields): BillingState {
  if (org.plan !== Plan.TRIAL) return { state: 'paid', plan: org.plan }
  const trialEndsAt = trialEndFor(org)
  const remainingMs = trialEndsAt.getTime() - Date.now()
  if (remainingMs <= 0) return { state: 'expired', plan: org.plan, trialEndsAt }
  return {
    state: 'trialing',
    plan: org.plan,
    trialEndsAt,
    daysLeft: Math.max(1, Math.ceil(remainingMs / DAY_MS)),
  }
}
