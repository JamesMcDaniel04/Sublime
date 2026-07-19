import { prisma } from '@/lib/prisma'
import { TOKENS_PER_CREDIT } from './limits'

/**
 * Additional-usage top-ups ("Additional usage available" on every plan).
 * A top-up is a one-time Stripe payment that grants a block of credits for
 * the current UTC month, stacked on top of the plan's monthly allowance.
 */

/** Credits granted per purchased pack. Overridable without a deploy. */
export function topupPackCredits(): number {
  const fromEnv = Number(process.env.TOPUP_PACK_CREDITS)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : 5_000
}

/** Current UTC month key, e.g. "2026-07" — matches the live usage counter. */
export function currentUsageMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Record a purchased grant. Idempotent on stripeRef: a webhook retry (or a
 * replayed event) can never double-grant.
 */
export async function grantTopupCredits(params: {
  organizationId: string
  credits: number
  stripeRef: string
  reason?: string
}): Promise<void> {
  const credits = Math.floor(params.credits)
  if (!Number.isFinite(credits) || credits <= 0) return
  await prisma.creditGrant.upsert({
    where: { stripeRef: params.stripeRef },
    update: {},
    create: {
      organizationId: params.organizationId,
      credits,
      month: currentUsageMonth(),
      reason: params.reason ?? 'topup',
      stripeRef: params.stripeRef,
    },
  })
}

/** Total granted credits for the org in the given (default: current) month. */
export async function topupCreditsForMonth(organizationId: string, month?: string): Promise<number> {
  const aggregate = await prisma.creditGrant.aggregate({
    where: { organizationId, month: month ?? currentUsageMonth() },
    _sum: { credits: true },
  })
  return aggregate._sum.credits ?? 0
}

/** Granted credits expressed in tokens, for the budget ceiling. */
export async function topupTokensForMonth(organizationId: string, month?: string): Promise<number> {
  return (await topupCreditsForMonth(organizationId, month)) * TOKENS_PER_CREDIT
}
