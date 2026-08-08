/**
 * Fresh-signup onboarding e2e: drives the REAL new-user path end to end.
 *
 *   1. brand-new Supabase identity → provisionUser (the auth-callback path)
 *   2. assert the provisioned workspace shape (own org, ADMIN, TRIAL plan)
 *   3. assert the billing gate puts a fresh org on the plan picker
 *      (payment_required, NOT grandfathered, trial not consumed)
 *   4. simulate Stripe conversion (plan + firstPaidAt like sync-subscription)
 *   5. drive the first-paint API surface (bootstrap, flows, goals,
 *      credentials, agents) as that user via real route modules
 *   6. invite a teammate → provision them → they join the SAME org as MEMBER
 *      and can read the member surface
 */
import crypto from 'node:crypto'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('fresh onboarding (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let systemPrisma: any
  let provisionUser: any
  let billingStateFor: any
  let isGrandfatheredOrganization: any
  let entitlementPlanFor: any
  let canManageBillingByRole: any
  let makeTestAuthContext: any
  let installTestAuth: any
  let clearTestAuth: any

  const orgIds: string[] = []
  let founder: any // provisioned db user (+organization)
  let founderIdentity: User

  function identity(email: string, overrides: Partial<User> = {}): User {
    return {
      id: crypto.randomUUID(),
      email,
      user_metadata: { full_name: 'Fresh Founder', email_verified: true },
      app_metadata: { provider: 'google' },
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      ...overrides,
    } as User
  }

  function getJson(mod: any, path: string) {
    const request = new NextRequest(`http://localhost${path}`)
    return Promise.resolve(mod.GET(request)).then(async (res: Response) => ({
      status: res.status,
      body: await res.json().catch(() => null),
    }))
  }

  before(async () => {
    ;({ systemPrisma } = await import('@/lib/prisma'))
    ;({ provisionUser } = await import('@/lib/supabase/auth-utils'))
    ;({ billingStateFor } = await import('@/lib/billing/trial'))
    ;({ isGrandfatheredOrganization, entitlementPlanFor } = await import('@/lib/billing/entitlements'))
    ;({ canManageBillingByRole } = await import('@/lib/server/permissions'))
    ;({ makeTestAuthContext, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth'))
  })

  after(async () => {
    clearTestAuth()
    for (const id of orgIds) {
      await systemPrisma.organization.deleteMany({ where: { id } }).catch(() => {})
    }
  })

  test('1+2. a brand-new signup provisions its own workspace as ADMIN on plan TRIAL', async () => {
    founderIdentity = identity(`founder-${crypto.randomUUID()}@example.com`)
    founder = await provisionUser(founderIdentity)
    assert.ok(founder.organizationId, 'workspace created')
    orgIds.push(founder.organizationId)
    assert.equal(founder.role, 'ADMIN')
    assert.equal(founder.organization.plan, 'TRIAL')
    assert.equal(founder.organization.slug, `org-${founderIdentity.id}`)
    assert.equal(founder.email, founderIdentity.email)
  })

  test('3. a fresh org lands on the plan picker: payment_required, not grandfathered, trial unconsumed', async () => {
    const org = founder.organization
    assert.equal(isGrandfatheredOrganization(org), false, 'fresh org must NOT be grandfathered')
    const billing = billingStateFor(org)
    assert.equal(billing.state, 'payment_required', 'paid-from-day-one: fresh org is locked')
    // the picker the founder sees must offer checkout (ADMIN can manage billing)
    assert.equal(canManageBillingByRole(founder.role), true)
    // one-time trial grant not consumed yet
    assert.equal(org.trialStartedAt ?? null, null)
  })

  test('4. simulated Stripe conversion flips the gate to paid', async () => {
    await systemPrisma.organization.update({
      where: { id: founder.organizationId },
      data: { plan: 'STARTER', firstPaidAt: new Date(), stripeSubscriptionId: `sub_${crypto.randomUUID()}` },
    })
    const org = await systemPrisma.organization.findUnique({ where: { id: founder.organizationId } })
    const billing = billingStateFor(org)
    assert.equal(billing.state, 'paid')
    assert.equal(billing.plan, 'STARTER')
    founder = { ...founder, organization: org }
  })

  test('5. first-paint API surface answers 200 for the newly paid founder', async () => {
    const plan = entitlementPlanFor(founder.organization)
    assert.equal(plan, 'STARTER', 'entitlements come from the real paid plan, not grandfathering')
    installTestAuth(makeTestAuthContext({
      organizationId: founder.organizationId,
      userId: founder.supabaseId,
      dbUser: founder,
      user: { id: founder.supabaseId } as never,
      role: founder.role,
      plan,
    }))

    const surfaces: Array<[string, string]> = [
      ['@/app/api/bootstrap/route', '/api/bootstrap'],
      ['@/app/api/flows/route', '/api/flows'],
      ['@/app/api/goals/route', '/api/goals'],
      ['@/app/api/credentials/route', '/api/credentials'],
      ['@/app/api/agents/route', '/api/agents'],
    ]
    for (const [module_, path] of surfaces) {
      const mod = await import(module_)
      const { status, body } = await getJson(mod, path)
      assert.equal(status, 200, `${path} → ${status}: ${JSON.stringify(body)?.slice(0, 200)}`)
      assert.equal(body?.success, true, `${path} success flag`)
    }

    // bootstrap carries the profile the shell paints for a brand-new user
    const bootstrap = await getJson(await import('@/app/api/bootstrap/route'), '/api/bootstrap')
    assert.equal(bootstrap.body.profile.profile.role, 'ADMIN')
    assert.equal(bootstrap.body.profile.profile.email, founderIdentity.email)
  })

  test('6. an invited teammate joins the founder workspace as MEMBER and can read it', async () => {
    const inviteEmail = `teammate-${crypto.randomUUID()}@example.com`
    await systemPrisma.organizationInvitation.create({
      data: {
        organizationId: founder.organizationId,
        email: inviteEmail,
        role: 'MEMBER',
        invitedById: founder.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })

    const teammate = await provisionUser(identity(inviteEmail, { user_metadata: { full_name: 'Teammate', email_verified: true } }))
    assert.equal(teammate.organizationId, founder.organizationId, 'invitee joins the inviting workspace')
    assert.equal(teammate.role, 'MEMBER')

    const invitation = await systemPrisma.organizationInvitation.findFirst({
      where: { organizationId: founder.organizationId, email: inviteEmail },
    })
    assert.ok(invitation.acceptedAt, 'invitation marked accepted')

    installTestAuth(makeTestAuthContext({
      organizationId: teammate.organizationId,
      userId: teammate.supabaseId,
      dbUser: teammate,
      user: { id: teammate.supabaseId } as never,
      role: teammate.role,
      plan: entitlementPlanFor(founder.organization),
    }))
    const { status, body } = await getJson(await import('@/app/api/flows/route'), '/api/flows')
    assert.equal(status, 200, `member /api/flows → ${status}: ${JSON.stringify(body)?.slice(0, 200)}`)
  })
}
