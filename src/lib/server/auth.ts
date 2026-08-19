import type { Plan, UserRole } from '@/generated/prisma/client'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { billingStateFor } from '@/lib/billing/trial'
import { entitlementPlanFor } from '@/lib/billing/entitlements'
import type { Actor } from './permissions'
import { prisma } from '@/lib/prisma'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
  /**
   * Stored workspace role. This used to be re-derived from createdAt at the
   * auth boundary; the grandfathered grant is now written to the column itself
   * (20260812010000_backfill_legacy_admin_role), so the database is the only
   * source. Never re-derive it downstream.
   */
  role: UserRole
  isAdmin: boolean
  /**
   * Effective plan from entitlementPlanFor(), NOT organization.plan: a
   * grandfathered workspace resolves to ENTERPRISE here, so entitlement gates
   * written against this field honour what those workspaces were promised.
   */
  plan: Plan
  /** Session assurance level ('aal1' | 'aal2' | undefined), for MFA step-up gating. */
  aal?: string
  /** The pure-permission view of this context, for can(). */
  actor: Actor
}

// Production-inert test seam: mirrors src/lib/observability/sentry.ts's
// injectable reporter. A route smoke test injects a seeded auth context so it
// can drive real handlers without a Supabase session. NEVER active in
// production — double-gated on NODE_ENV and TEST_DATABASE_URL (production sets
// neither), and null by default so real auth runs unless a test injects.
let testAuthContext: AuthContext | null = null

export function setTestAuthContext(ctx: AuthContext | null): void {
  testAuthContext = ctx
}

function testAuthActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 402 | 403,
    readonly code: string = 'AUTH_ERROR',
  ) {
    super(message)
    this.name = 'AuthContextError'
  }
}

const LAST_SEEN_THROTTLE_MS = 24 * 60 * 60 * 1000

/** Atomic, best-effort presence stamp used by the inactive-user lifecycle
 * sweep. It never adds latency to or fails an authenticated request. */
export function touchLastSeen(userId: string, now = new Date()): void {
  void prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_THROTTLE_MS) } }],
    },
    data: { lastSeenAt: now },
  }).catch(() => {})
}

export async function requireAuthContext(): Promise<AuthContext> {
  if (testAuthContext && testAuthActive()) return testAuthContext

  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  // Count a visit to the billing wall as activity; an actively returning user
  // must not receive a win-back message merely because payment is locked.
  touchLastSeen(auth.dbUser.id)

  // Payment enforcement: every data API flows through here, so an unpaid
  // workspace is blocked server-side (not just in the UI). Billing endpoints
  // (/api/billing/status, /api/stripe/*) deliberately do NOT use this wrapper
  // so a locked-out user can still see their status, subscribe, and pay.
  const organization = auth.dbUser.organization
  if (organization && billingStateFor(organization).state === 'payment_required') {
    throw new AuthContextError(
      'Choose a paid plan to start using Sublime. You can cancel anytime.',
      402,
      'PAYMENT_REQUIRED',
    )
  }

  const role = auth.dbUser.role
  const plan = entitlementPlanFor(organization)

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
    role,
    isAdmin: role === 'ADMIN',
    plan,
    aal: auth.aal,
    actor: {
      userId: auth.userId,
      role,
      plan,
      // The platform axis. Both halves are read from the request's own rows, so
      // the tier is re-evaluated every request rather than cached anywhere: a
      // revoked role or a workspace move takes effect immediately.
      platformRole: auth.dbUser.platformRole,
      orgKind: organization?.kind ?? null,
      // Identity root for the owner grant — the DB columns above can be wrong.
      email: auth.dbUser.email,
    },
  }
}
