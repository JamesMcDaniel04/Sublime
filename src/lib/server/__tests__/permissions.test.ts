import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan, type UserRole } from '@/generated/prisma/client'
import {
  CAPABILITIES,
  can,
  canManageBillingByRole,
  denialReason,
  type Actor,
  type Capability,
} from '../permissions'

const ROLES: UserRole[] = ['ADMIN', 'MEMBER']
const PLANS: Plan[] = [Plan.TRIAL, Plan.STARTER, Plan.PROFESSIONAL, Plan.BUSINESS, Plan.ENTERPRISE]
const TEAM_PLANS: Plan[] = [Plan.PROFESSIONAL, Plan.BUSINESS, Plan.ENTERPRISE]

const actor = (role: UserRole, plan: Plan): Actor => ({ userId: 'u1', role, plan })

/**
 * The expected answer, written INDEPENDENTLY of can()'s implementation — a
 * table that restated the implementation's own sets would pass no matter what
 * can() did.
 */
function expected(role: UserRole, plan: Plan, capability: Capability): boolean {
  if (capability === 'goal:read:all') return TEAM_PLANS.includes(plan)
  // The platform tier is off the workspace axes entirely: no role and no plan
  // reaches it, so every actor in this matrix — which carries neither a
  // platformRole nor an org kind — must be denied it.
  if (capability === 'platform:administer') return false
  return role === 'ADMIN'
}

test('can() over the full role x plan x capability matrix', () => {
  let checked = 0
  for (const role of ROLES) {
    for (const plan of PLANS) {
      for (const capability of CAPABILITIES) {
        assert.equal(
          can(actor(role, plan), capability),
          expected(role, plan, capability),
          `${role} on ${plan} for ${capability}`,
        )
        checked++
      }
    }
  }
  // Guards against the matrix silently shrinking if CAPABILITIES loses an entry.
  assert.equal(checked, ROLES.length * PLANS.length * CAPABILITIES.length)
  assert.equal(CAPABILITIES.length, 9)
})

test('restricting a goal is admin-only and not plan-gated', () => {
  // Hiding a goal from colleagues is an admin act on any plan — it is a
  // governance control, not something a workspace buys.
  assert.equal(can(actor('ADMIN', Plan.STARTER), 'goal:restrict'), true)
  assert.equal(can(actor('MEMBER', Plan.ENTERPRISE), 'goal:restrict'), false)
})

test('plan is evaluated before role: an admin cannot buy past billing', () => {
  // The single most important property in the module. If someone reorders the
  // two checks in can(), this fails.
  const adminOnIndividual = actor('ADMIN', Plan.STARTER)
  assert.equal(can(adminOnIndividual, 'goal:read:all'), false)
  assert.equal(denialReason(adminOnIndividual, 'goal:read:all'), 'plan')
})

test('the cross-goal view is bought, not granted by role', () => {
  // A MEMBER on Team gets it; an ADMIN on Individual does not.
  assert.equal(can(actor('MEMBER', Plan.PROFESSIONAL), 'goal:read:all'), true)
  assert.equal(can(actor('ADMIN', Plan.STARTER), 'goal:read:all'), false)
})

test('denialReason names the actual blocker', () => {
  // A member refused for want of the role must not be sent to the billing page…
  assert.equal(denialReason(actor('MEMBER', Plan.ENTERPRISE), 'member:manage'), 'role')
  // …and an admin refused for want of a tier must not be told to become an admin.
  assert.equal(denialReason(actor('ADMIN', Plan.STARTER), 'goal:read:all'), 'plan')
  // Granted capabilities report no reason.
  assert.equal(denialReason(actor('ADMIN', Plan.ENTERPRISE), 'member:manage'), null)
})

test('TRIAL (the unpaid sentinel) grants no cross-goal view', () => {
  for (const role of ROLES) {
    assert.equal(can(actor(role, Plan.TRIAL), 'goal:read:all'), false)
  }
})

test('every admin-only capability refuses a member on every plan', () => {
  const adminOnly = CAPABILITIES.filter((c) => c !== 'goal:read:all')
  for (const plan of PLANS) {
    for (const capability of adminOnly) {
      assert.equal(can(actor('MEMBER', plan), capability), false, `${capability} on ${plan}`)
    }
  }
})

/**
 * The billing routes authenticate by session rather than withAuthenticatedApi
 * (so a plan-locked workspace can still reach checkout), which leaves them
 * with a role but no entitlement plan. canManageBillingByRole exists for that
 * seam; these two tests are what make the shortcut safe.
 */
test('canManageBillingByRole: admins may manage billing, members may not', () => {
  assert.equal(canManageBillingByRole('ADMIN'), true)
  assert.equal(canManageBillingByRole('MEMBER'), false)
})

test('billing:manage is role-gated only, so a role alone decides it', () => {
  // If billing:manage ever became plan-gated, answering from the role alone
  // would silently start lying. Pin the property the shortcut depends on.
  for (const plan of PLANS) {
    assert.equal(can(actor('ADMIN', plan), 'billing:manage'), true, `ADMIN on ${plan}`)
    assert.equal(can(actor('MEMBER', plan), 'billing:manage'), false, `MEMBER on ${plan}`)
  }
})
