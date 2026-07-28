/**
 * Which Stripe subscription statuses keep a workspace inside the product.
 *
 * `trialing` belongs here and its absence was a real bug: a card-collected
 * trial subscription sits in `trialing`, so leaving it out downgraded the org
 * to TRIAL the instant checkout completed — locking out the user who had just
 * handed us a card.
 */
const GRANTS_ACCESS = new Set(['active', 'trialing'])

/**
 * `past_due` is deliberately conditional. Stripe retries a failed charge for
 * roughly three weeks, and cutting off a customer who has paid for months
 * because one renewal bounced generates support load and churn. But a trial
 * whose very first charge fails has never paid us anything, and letting that
 * org keep working through the whole dunning window hands out ~5 free weeks.
 *
 * `firstPaidAt` is what separates the two, which is why the migration that
 * adds it MUST backfill existing paying orgs — a NULL there reads as "never
 * paid us" and would lock out a real customer.
 */
export function subscriptionGrantsAccess(status: string, firstPaidAt: Date | null): boolean {
  if (GRANTS_ACCESS.has(status)) return true
  if (status === 'past_due') return firstPaidAt != null
  return false
}
