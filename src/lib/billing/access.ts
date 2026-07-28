import { Plan } from '@prisma/client'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { billingStateFor } from './trial'
import { apiLogger } from '@/lib/logger'

export type BillingAccess =
  /** Workspace may use the product. `trialEndsAt` is set only while trialing. */
  | { status: 'allowed'; plan: Plan; trialEndsAt: Date | null }
  /** Signed in, but no card on file — render the plan picker. */
  | { status: 'payment_required' }
  /** Couldn't determine billing state (DB/auth failure) — render an error. */
  | { status: 'unavailable' }

/**
 * Server-side entry gate for the (app) route group.
 *
 * This deliberately does NOT introduce a second access rule: it defers to
 * billingStateFor(), the same function the API layer's 402 uses, so the page
 * and its data can never disagree about whether a workspace is paid.
 *
 * Middleware has already bounced unauthenticated visitors to /auth/login, so
 * reaching here without a session means the session died mid-flight.
 */
export async function resolveBillingAccess(): Promise<BillingAccess> {
  try {
    const auth = await getAuthWithUser()
    const organization = auth?.dbUser?.organization
    if (!organization) return { status: 'payment_required' }

    const billing = billingStateFor(organization)
    if (billing.state === 'payment_required') return { status: 'payment_required' }

    return {
      status: 'allowed',
      plan: billing.plan,
      trialEndsAt: organization.trialEndsAt,
    }
  } catch (error) {
    // Fail to an honest error, NOT to the plan picker and NOT to the app.
    // Showing "choose a plan" to a paying customer because Postgres blinked is
    // worse than a visible error; rendering the app is pointless when every
    // data API behind it will fail too.
    apiLogger.error('billing access could not be resolved', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: 'unavailable' }
  }
}

/** Whole days left in the trial, or null when not trialing. Never negative. */
export function trialDaysRemaining(trialEndsAt: Date | null | undefined, now = new Date()): number | null {
  if (!trialEndsAt) return null
  const ms = trialEndsAt.getTime() - now.getTime()
  if (ms <= 0) return 0
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}
