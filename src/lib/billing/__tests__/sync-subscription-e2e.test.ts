/**
 * DB-backed tests for the shared Stripe→plan sync (extracted from the webhook
 * route, which previously had no logic tests at all). applySubscription takes
 * plain data, so a hand-built object cast to Stripe.Subscription exercises the
 * real Prisma writes with no Stripe network.
 *
 * Gated on TEST_DATABASE_URL like rbac-e2e — see the `verify` skill.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import type Stripe from 'stripe'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // planForPriceId reads env at call time, so this is all the wiring needed.
  process.env.STRIPE_PRICE_TEAM = 'price_team_test'

  let prisma: any
  let sync: typeof import('../sync-subscription')
  const orgIds: string[] = []

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    sync = await import('../sync-subscription')
  })
  after(async () => {
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
  })

  async function seedOrg(data: Record<string, unknown> = {}) {
    const org = await prisma.organization.create({
      data: { name: 'Sync', slug: `sync-${crypto.randomUUID()}`, ...data },
    })
    orgIds.push(org.id)
    return org
  }

  // stripeCustomerId is unique on Organization and applySubscription writes it
  // through — every fake subscription needs its own customer id.
  const fakeSubscription = (over: Record<string, unknown>) => ({
    id: 'sub_test',
    customer: `cus_${crypto.randomUUID()}`,
    status: 'active',
    items: { data: [{ price: { id: 'price_team_test' } }] },
    trial_end: null,
    metadata: {},
    ...over,
  }) as unknown as Stripe.Subscription

  test('a canceled subscription reverts the org to TRIAL and clears the subscription id', async () => {
    const org = await seedOrg({ plan: 'PROFESSIONAL', stripeSubscriptionId: 'sub_test' })
    await sync.applySubscription(fakeSubscription({ status: 'canceled', metadata: { organizationId: org.id } }))
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'TRIAL')
    assert.equal(updated.stripeSubscriptionId, null)
  })

  test('a trialing subscription with a recognized price grants the plan and mirrors trial bookkeeping', async () => {
    const org = await seedOrg({ plan: 'TRIAL' })
    const trialEnd = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60
    await sync.applySubscription(fakeSubscription({
      status: 'trialing', trial_end: trialEnd, metadata: { organizationId: org.id },
    }))
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'PROFESSIONAL')
    assert.equal(updated.trialEndsAt?.getTime(), trialEnd * 1000)
    assert.ok(updated.trialStartedAt, 'trialStartedAt stamped on first trial')
  })

  test('an active subscription with an unrecognized price never downgrades a paying org', async () => {
    const org = await seedOrg({ plan: 'BUSINESS', stripeSubscriptionId: 'sub_test' })
    await sync.applySubscription(fakeSubscription({
      items: { data: [{ price: { id: 'price_unknown' } }] },
      metadata: { organizationId: org.id },
    }))
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'BUSINESS')
    assert.equal(updated.stripeSubscriptionId, 'sub_test')
  })

  test('reconcile treats a vanished subscription as a cancellation', async () => {
    const org = await seedOrg({ plan: 'PROFESSIONAL', stripeSubscriptionId: 'sub_gone' })
    const stripe = {
      subscriptions: {
        retrieve: async () => {
          throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' })
        },
      },
    } as unknown as Stripe
    const result = await sync.reconcileOrganizationSubscription(stripe, {
      id: org.id, stripeSubscriptionId: 'sub_gone',
    })
    assert.equal(result.outcome, 'cleared')
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'TRIAL')
    assert.equal(updated.stripeSubscriptionId, null)
    assert.equal(updated.trialEndsAt, null)
  })

  test('reconcile re-applies a live subscription', async () => {
    const org = await seedOrg({ plan: 'TRIAL', stripeSubscriptionId: 'sub_live' })
    const stripe = {
      subscriptions: {
        retrieve: async () => fakeSubscription({ id: 'sub_live', metadata: { organizationId: org.id } }),
      },
    } as unknown as Stripe
    const result = await sync.reconcileOrganizationSubscription(stripe, {
      id: org.id, stripeSubscriptionId: 'sub_live',
    })
    assert.equal(result.outcome, 'synced')
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'PROFESSIONAL')
  })
} else {
  test('sync-subscription e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
