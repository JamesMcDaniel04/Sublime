/**
 * Workspace authorization: what a signed-in person is allowed to DO.
 *
 * This is the third and last access axis in the codebase, and the three are
 * deliberately separate because they answer different questions:
 *
 *   tenant-guard.ts  — which ORG's rows may this query touch
 *   visibility.ts    — which ROWS inside the org may this user see/edit
 *   permissions.ts   — which ACTIONS may this user take at all   (here)
 *
 * Like visibility.ts, `can()` is pure and synchronous: no Prisma, no fetch, no
 * clock. That is what makes the role x plan x capability matrix exhaustively
 * testable instead of sampled — see __tests__/permissions.test.ts.
 *
 * Evaluation order is fixed and enforced below: PLAN entitlement is checked
 * BEFORE role, so being an admin can never substitute for having bought the
 * tier. `goal:read:all` is the case where both apply — an admin on the
 * Individual plan still does not get the cross-goal view.
 */

import type { Plan, UserRole } from '@prisma/client'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'

/**
 * The closed set of privileged actions. Closed on purpose: a typo or an
 * invented capability is a compile error, not a silently-false check.
 *
 * Anything NOT listed here needs no capability beyond workspace membership —
 * routes declare that as `requires: 'member'` (see api-handler.ts).
 */
export type Capability =
  /** Author an org-level goal (Goal.ownerUserId = null). */
  | 'goal:create:org'
  /** The cross-goal ("All goals") lens. Plan-gated as well as role-open. */
  | 'goal:read:all'
  /** Activity and usage roll-ups across every member of the workspace. */
  | 'insights:workspace'
  /** Invite, remove, suspend, or change the role of a member. */
  | 'member:manage'
  /** Plan changes, checkout, portal, top-ups. */
  | 'billing:manage'
  /** Read / edit / delete / reassign another member's work. Always audited. */
  | 'resource:takeover'
  /** Workspace-wide settings that affect everyone. */
  | 'settings:workspace'
  /**
   * Mark a goal restricted and manage its members. Deliberately NOT
   * settings:workspace — "can change workspace configuration" and "can hide a
   * goal from colleagues" should stay separately revocable, and a closed union
   * makes adding the distinction cheap.
   */
  | 'goal:restrict'

export const CAPABILITIES: readonly Capability[] = [
  'goal:create:org',
  'goal:read:all',
  'insights:workspace',
  'member:manage',
  'billing:manage',
  'resource:takeover',
  'settings:workspace',
  'goal:restrict',
] as const

/**
 * Everything `can()` needs, and nothing more — no Prisma row, so tests can
 * construct an actor literally and callers can't accidentally depend on
 * unrelated user fields.
 *
 * `role` is the EFFECTIVE role: auth-utils.ts normalizes legacy platform users
 * to ADMIN at the auth boundary, and this module deliberately does not
 * re-derive that (doing so would drop legacy super-admins).
 *
 * `plan` is the EFFECTIVE plan from entitlementPlanFor(), not organization.plan,
 * so grandfathered workspaces keep what they were promised.
 */
export type Actor = {
  userId: string
  role: UserRole
  plan: Plan
}

/** Capabilities that require a plan entitlement regardless of role. */
function planAllows(plan: Plan, capability: Capability): boolean {
  if (capability === 'goal:read:all') return capabilitiesForPlan(plan).allGoalsView
  return true
}

/** Capabilities reserved to workspace admins. */
const ADMIN_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  'goal:create:org',
  'insights:workspace',
  'member:manage',
  'billing:manage',
  'resource:takeover',
  'settings:workspace',
  'goal:restrict',
])

/**
 * The single authorization question. Pure — same answer for the same inputs,
 * always.
 *
 * Note `goal:read:all` is intentionally NOT in ADMIN_ONLY: the cross-goal lens
 * is something a workspace BUYS, not something admins are given. A member on
 * the Team plan gets it; an admin on Individual does not.
 */
export function can(actor: Actor, capability: Capability): boolean {
  // Plan first — see the module header. Reordering these two lines would let
  // an admin bypass billing, so the order is load-bearing and covered by a test.
  if (!planAllows(actor.plan, capability)) return false
  if (ADMIN_ONLY.has(capability)) return actor.role === 'ADMIN'
  return true
}

/** Convenience for the common branch. Kept here so 'ADMIN' has one home. */
export function isAdmin(actor: Pick<Actor, 'role'>): boolean {
  return actor.role === 'ADMIN'
}

/**
 * Billing authorization for the one seam that has a role but no Actor.
 *
 * The Stripe checkout/portal/topup routes deliberately skip
 * withAuthenticatedApi so a workspace locked out by its PLAN can still reach
 * payment — requireAuthContext() would throw PAYMENT_REQUIRED at exactly the
 * people who need to pay. That exemption is about plan, not role: without a
 * role check any member could open the customer portal and cancel the
 * subscription.
 *
 * Answering from the role alone is only valid because billing:manage is not
 * plan-gated. That is a property of the matrix above, not an assumption —
 * permissions.test.ts pins it, so making billing:manage plan-gated later fails
 * the test instead of silently changing what this returns. The plan passed
 * here is the most restrictive one for that reason: if it ever started
 * mattering, this would deny rather than over-grant.
 */
export function canManageBillingByRole(role: UserRole): boolean {
  return can({ userId: '', role, plan: 'TRIAL' as Plan }, 'billing:manage')
}

/**
 * WHY a capability was denied, so the caller can say something true rather
 * than a generic 403. "Upgrade your plan" shown to an admin who actually needs
 * a higher tier is helpful; "Admin access required" shown to the same person
 * is a support ticket.
 *
 * Returns null when the capability is granted.
 */
export function denialReason(actor: Actor, capability: Capability): 'plan' | 'role' | null {
  if (!planAllows(actor.plan, capability)) return 'plan'
  if (ADMIN_ONLY.has(capability) && actor.role !== 'ADMIN') return 'role'
  return null
}
