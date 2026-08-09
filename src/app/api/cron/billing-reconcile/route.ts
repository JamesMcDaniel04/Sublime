/**
 * /api/cron/billing-reconcile — daily Stripe↔plan reconciliation.
 *
 * Webhooks are the primary path for plan changes; this closes the failure
 * mode where a missed subscription webhook leaves a lapsed workspace on a
 * paid plan forever. For every org holding a subscription id, re-fetch the
 * subscription and re-apply it; a vanished subscription applies as canceled.
 * Also alarms on orgs that claim a paid plan with no subscription at all.
 *
 * Auth (fail closed): identical CRON_SECRET bearer check as /api/cron/dispatch
 * — 503 when unconfigured, constant-time compare, no header-only bypass.
 */

import { timingSafeEqual } from 'crypto'
import { Plan } from '@/generated/prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { reconcileOrganizationSubscription } from '@/lib/billing/sync-subscription'
import { GRANDFATHERED_WORKSPACE_CUTOFF } from '@/lib/billing/entitlements'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  }
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized
  try {
    const stripe = getStripe()
    // systemPrisma: global billing sweep across all orgs by design (CRON_SECRET-gated).
    const orgs = await systemPrisma.organization.findMany({
      where: { stripeSubscriptionId: { not: null } },
      select: { id: true, stripeSubscriptionId: true },
      take: 500,
    })
    let synced = 0
    let cleared = 0
    let failed = 0
    for (const org of orgs) {
      try {
        const result = await reconcileOrganizationSubscription(stripe, {
          id: org.id,
          stripeSubscriptionId: org.stripeSubscriptionId!,
        })
        if (result.outcome === 'synced') synced += 1
        else cleared += 1
      } catch (error) {
        // Per-org isolation: one flaky retrieve must not abort the sweep.
        failed += 1
        apiLogger.error('billing-reconcile: org reconcile failed', {
          organizationId: org.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // A paid plan with no subscription and no grandfather marker cannot be
    // reached by any legitimate write path — alarm, don't auto-downgrade.
    // systemPrisma: global billing sweep across all orgs by design (CRON_SECRET-gated).
    const orphans = await systemPrisma.organization.findMany({
      where: {
        plan: { not: Plan.TRIAL },
        stripeSubscriptionId: null,
        grandfatheredAt: null,
        createdAt: { gt: GRANDFATHERED_WORKSPACE_CUTOFF },
      },
      select: { id: true, plan: true },
      take: 100,
    })
    if (orphans.length > 0) {
      apiLogger.error('billing-reconcile: paid orgs with no subscription', {
        organizationIds: orphans.map((org) => org.id),
      })
      captureError(new Error('Paid organization(s) with no Stripe subscription'), {
        scope: 'billing.reconcile',
        count: orphans.length,
      })
    }

    return Response.json({ success: true, checked: orgs.length, synced, cleared, failed, orphaned: orphans.length })
  } catch (error) {
    apiLogger.error('billing-reconcile: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
