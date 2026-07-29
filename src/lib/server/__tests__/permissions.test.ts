import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan, type UserRole } from '@prisma/client'
import { CAPABILITIES, can, denialReason, type Actor, type Capability } from '../permissions'

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
  assert.equal(CAPABILITIES.length, 8)
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
