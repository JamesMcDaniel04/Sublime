import type { Plan, UserRole } from '@prisma/client'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { billingStateFor } from '@/lib/billing/trial'
import { entitlementPlanFor } from '@/lib/billing/entitlements'
import type { Actor } from './permissions'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
  /**
   * Effective workspace role. auth-utils.ts normalizes legacy platform users
   * to ADMIN at the auth boundary, so this is already the effective value —
   * never re-derive it downstream.
   */
  role: UserRole
  isAdmin: boolean
  /**
   * Effective plan from entitlementPlanFor(), NOT organization.plan: a
   * grandfathered workspace resolves to ENTERPRISE here, so entitlement gates
   * written against this field honour what those workspaces were promised.
   */
  plan: Plan
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

export async function requireAuthContext(): Promise<AuthContext> {
  if (testAuthContext && testAuthActive()) return testAuthContext

  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

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
    actor: { userId: auth.userId, role, plan },
  }
}
