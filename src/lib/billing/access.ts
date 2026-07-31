import { Plan } from '@prisma/client'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { canManageBillingByRole } from '@/lib/server/permissions'
import { billingStateFor, trialDaysRemaining } from './trial'
import { apiLogger } from '@/lib/logger'

export type BillingAccess =
  /** Workspace may use the product. `trialEndsAt` is set only while trialing. */
  | { status: 'allowed'; plan: Plan; trialEndsAt: Date | null }
  /**
   * Signed in, but no card on file — render the plan picker.
   *
   * `canManageBilling` rides along because the paywall is shown to every
   * member, not only the people allowed to pay, and the picker must not offer
   * a checkout link that billing:manage will refuse. `trialUsed` rides along
   * because the free trial is a one-time grant: a workspace that consumed it
   * must be offered a subscription, not another "14 days free" that Stripe
   * would charge immediately.
   */
  | { status: 'payment_required'; canManageBilling: boolean; trialUsed: boolean }
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
    // dbUser.role is already the EFFECTIVE role — getAuthWithUser normalizes
    // legacy platform users to ADMIN, so this agrees with the API layer.
    const canManageBilling = auth?.dbUser ? canManageBillingByRole(auth.dbUser.role) : false
    const organization = auth?.dbUser?.organization
    if (!organization) return { status: 'payment_required', canManageBilling, trialUsed: false }

    const billing = billingStateFor(organization)
    if (billing.state === 'payment_required') {
      return { status: 'payment_required', canManageBilling, trialUsed: organization.trialStartedAt != null }
    }

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

export { trialDaysRemaining }
