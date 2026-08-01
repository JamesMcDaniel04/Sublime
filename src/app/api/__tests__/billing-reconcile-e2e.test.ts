/**
 * Route-level QA drive for /api/cron/billing-reconcile — the daily sweep that
 * mutates organization.plan across ALL orgs, previously untested.
 *
 * Follows the route-smoke protocol: real Postgres (TEST_DATABASE_URL), the
 * REAL route handler driven with NextRequest objects. Stripe is stubbed the
 * way sync-subscription-e2e stubs it — no network — but here the stub is
 * installed on the cached client `getStripe()` returns, because the route
 * builds its own client instead of accepting one.
 *
 * The QA database is persistent and shared, so the stub throws a GENERIC
 * error for any subscription id this file did not seed: the route's per-org
 * isolation counts those as `failed` and leaves their rows untouched, and
 * every count assertion below is `>=` / delta-based rather than exact.
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'qa-cron-secret'
  // The stub never hits the network, but getStripe() refuses to construct a
  // client without a key. planForPriceId reads env at call time (see
  // sync-subscription-e2e), so this is all the price wiring needed.
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_qa_reconcile'
  process.env.STRIPE_PRICE_TEAM = 'price_team_test'

  let prisma: any
  const orgIds: string[] = []

  // subscription id → producer; producers either return a fake subscription
  // or throw the Stripe error shape under test.
  const stubbedSubs = new Map<string, () => unknown>()

  const req = (path: string, init?: RequestInit) => new NextRequest(new URL(`http://test${path}`), init as never)
  const cronReq = (secret?: string) =>
    req('/api/cron/billing-reconcile', { headers: secret ? { authorization: `Bearer ${secret}` } : {} })
  const runRoute = async (secret?: string) => (await import('../cron/billing-reconcile/route')).GET(cronReq(secret))

  const missingSubError = () =>
    Object.assign(new Error('No such subscription'), { code: 'resource_missing' })

  // stripeCustomerId is unique on Organization and applySubscription writes it
  // through — every fake subscription needs its own customer id.
  const fakeSubscription = (over: Record<string, unknown>) => ({
    id: 'sub_qa',
    customer: `cus_${crypto.randomUUID()}`,
    status: 'active',
    items: { data: [{ price: { id: 'price_team_test' } }] },
    trial_end: null,
    metadata: {},
    ...over,
  })

  async function seedOrg(data: Record<string, unknown> = {}) {
    const org = await prisma.organization.create({
      data: { name: 'Reconcile', slug: `reconcile-${crypto.randomUUID()}`, ...data },
    })
    orgIds.push(org.id)
    return org
  }

  const findOrg = (id: string) => prisma.organization.findUnique({ where: { id } })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    // Patch subscriptions.retrieve on the module-level cached client — the
    // route's getStripe() call returns this same instance.
    const { getStripe } = await import('@/lib/stripe')
    const stripe = getStripe() as any
    stripe.subscriptions.retrieve = async (id: string) => {
      const producer = stubbedSubs.get(id)
      // Pre-existing rows in the shared QA DB: fail their retrieve with a
      // NON-resource_missing error so the sweep counts them as failed and
      // never mutates them (resource_missing would clear real rows).
      if (!producer) throw new Error(`stub: unexpected subscription ${id}`)
      return producer()
    }
  })

  after(async () => {
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
  })

  test('auth: missing and wrong bearer are rejected with 401', async () => {
    const missing = await runRoute()
    assert.equal(missing.status, 401)
    const wrong = await runRoute('wrong-secret')
    assert.equal(wrong.status, 401)
  })

  test('auth: fails closed with 503 when CRON_SECRET is unconfigured', async () => {
    const saved = process.env.CRON_SECRET
    delete process.env.CRON_SECRET
    try {
      // Even a request presenting the (former) secret must be refused.
      const res = await runRoute(saved)
      assert.equal(res.status, 503)
    } finally {
      process.env.CRON_SECRET = saved
    }
  })

  // Carried between the two sweep tests: orphan count from the first run is
  // the baseline the grandfathering test compares against.
  let orphanedBaseline = -1

  test('sweep: corrects drifted orgs, clears vanished subscriptions, never touches the rest', async () => {
    // Drifted down: DB says TRIAL but Stripe holds a live paid subscription
    // (the missed-webhook failure mode in the upgrade direction).
    const subLive = `sub_qa_live_${crypto.randomUUID()}`
    const orgLive = await seedOrg({ plan: 'TRIAL', stripeSubscriptionId: subLive })
    stubbedSubs.set(subLive, () =>
      fakeSubscription({ id: subLive, metadata: { organizationId: orgLive.id } }))

    // Drifted up: DB says PROFESSIONAL but the subscription no longer exists
    // (missed customer.subscription.deleted — the lapsed-forever failure mode).
    const subGone = `sub_qa_gone_${crypto.randomUUID()}`
    const orgGone = await seedOrg({
      plan: 'PROFESSIONAL', stripeSubscriptionId: subGone, trialEndsAt: new Date(),
    })
    stubbedSubs.set(subGone, () => { throw missingSubError() })

    // Grandfathered org whose subscription vanished: keeps ENTERPRISE, only
    // the dangling subscription id is cleared.
    const subGfGone = `sub_qa_gf_${crypto.randomUUID()}`
    const orgGf = await seedOrg({
      plan: 'ENTERPRISE', stripeSubscriptionId: subGfGone, grandfatheredAt: new Date('2026-07-01T00:00:00Z'),
    })
    stubbedSubs.set(subGfGone, () => { throw missingSubError() })

    // Active subscription with an unrecognized price: a config bug, not a
    // cancellation — the paying org must NOT be downgraded.
    const subBadPrice = `sub_qa_badprice_${crypto.randomUUID()}`
    const orgBadPrice = await seedOrg({ plan: 'BUSINESS', stripeSubscriptionId: subBadPrice })
    stubbedSubs.set(subBadPrice, () =>
      fakeSubscription({
        id: subBadPrice,
        items: { data: [{ price: { id: 'price_not_configured_anywhere' } }] },
        metadata: { organizationId: orgBadPrice.id },
      }))

    // Paid plan, no subscription, post-cutoff, no grandfather marker: the
    // orphan alarm case — reported, never auto-downgraded.
    const orgOrphan = await seedOrg({ plan: 'BUSINESS' })

    // No Stripe presence at all: outside the sweep entirely, skipped without
    // error and without a write.
    const orgNoStripe = await seedOrg({ plan: 'TRIAL' })

    const res = await runRoute(process.env.CRON_SECRET)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.ok(body.checked >= 4, `checked=${body.checked}`)
    assert.ok(body.synced >= 2, `synced=${body.synced}`)   // orgLive + orgBadPrice
    assert.ok(body.cleared >= 2, `cleared=${body.cleared}`) // orgGone + orgGf
    assert.ok(body.orphaned >= 1, `orphaned=${body.orphaned}`)
    orphanedBaseline = body.orphaned

    const live = await findOrg(orgLive.id)
    assert.equal(live.plan, 'PROFESSIONAL', 'drifted-down org not upgraded to its live subscription plan')
    assert.equal(live.stripeSubscriptionId, subLive)
    assert.ok(live.stripeCustomerId, 'customer id from the live subscription not written through')

    const gone = await findOrg(orgGone.id)
    assert.equal(gone.plan, 'TRIAL', 'lapsed org kept its paid plan')
    assert.equal(gone.stripeSubscriptionId, null)
    assert.equal(gone.trialEndsAt, null, 'stale trialEndsAt survived the clear')

    const gf = await findOrg(orgGf.id)
    assert.equal(gf.plan, 'ENTERPRISE', 'grandfathered org lost ENTERPRISE on a vanished subscription')
    assert.equal(gf.stripeSubscriptionId, null, 'dangling subscription id not cleared on grandfathered org')

    const badPrice = await findOrg(orgBadPrice.id)
    assert.equal(badPrice.plan, 'BUSINESS', 'paying org downgraded over an unrecognized price')
    assert.equal(badPrice.stripeSubscriptionId, subBadPrice)

    const orphan = await findOrg(orgOrphan.id)
    assert.equal(orphan.plan, 'BUSINESS', 'orphan alarm must not auto-downgrade')
    assert.equal(orphan.stripeSubscriptionId, null)

    const untouched = await findOrg(orgNoStripe.id)
    assert.equal(untouched.plan, 'TRIAL')
    assert.equal(untouched.stripeSubscriptionId, null)
    assert.equal(untouched.stripeCustomerId, null)
  })

  test('sweep: grandfathered and pre-cutoff orgs without subscriptions are not orphans', async () => {
    assert.ok(orphanedBaseline >= 1, 'baseline sweep must have run first')

    // Explicit grandfather marker.
    const orgMarked = await seedOrg({ plan: 'ENTERPRISE', grandfatheredAt: new Date('2026-07-01T00:00:00Z') })
    // Implicit grandfathering: created before the paid-launch cutoff
    // (GRANDFATHERED_WORKSPACE_CUTOFF, 2026-07-19).
    const orgPreCutoff = await seedOrg({ plan: 'BUSINESS', createdAt: new Date('2026-07-01T00:00:00Z') })

    const res = await runRoute(process.env.CRON_SECRET)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)

    // The orphan alarm is a pure WHERE clause (paid plan, no subscription, no
    // grandfather marker, post-cutoff creation). Assert it directly against
    // the two seeds — a global-count comparison is racy on the shared QA DB,
    // where concurrent suites seed orgs between the two sweeps.
    const { systemPrisma } = await import('@/lib/prisma')
    const matched = await systemPrisma.organization.findMany({
      where: {
        id: { in: [orgMarked.id, orgPreCutoff.id] },
        plan: { not: 'TRIAL' },
        stripeSubscriptionId: null,
        grandfatheredAt: null,
        createdAt: { gt: new Date('2026-07-19T00:00:00Z') },
      },
      select: { id: true },
    })
    assert.deepEqual(matched, [], 'grandfathered/pre-cutoff org matched the orphan alarm clause')

    assert.equal((await findOrg(orgMarked.id)).plan, 'ENTERPRISE')
    assert.equal((await findOrg(orgPreCutoff.id)).plan, 'BUSINESS')
  })
} else {
  test('billing-reconcile e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
