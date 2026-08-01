/**
 * Route-level tests for the four Stripe routes (webhook POST + the three
 * redirect GETs: checkout, portal, topup).
 *
 * The webhook is exercised with REAL Stripe-Signature headers: constructEvent
 * verifies HMAC-SHA256 over `${timestamp}.${payload}`, so the tests compute
 * that themselves and assert the DB-visible effect (plan sync, firstPaidAt).
 *
 * The GETs authenticate via requireAuth() (Supabase session cookie), which the
 * setTestAuthContext seam deliberately cannot reach (see route-smoke.test.ts).
 * So these tests drive the REAL auth path instead: the handler runs inside a
 * minimal Next request scope (workAsyncStorage + workUnitAsyncStorage) so
 * `cookies()` resolves, and a local HTTP stub plays Supabase's /auth/v1/user —
 * supabase-js delegates HS256 token verification to exactly that endpoint. A
 * session cookie for a seeded user therefore authenticates as that user with
 * that user's DB role, which is what the canManageBillingByRole gate reads.
 *
 * Gated on TEST_DATABASE_URL like the rest of the e2e suites — see `verify`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AddressInfo } from 'node:net'
import type { NextRequest as NextRequestType } from 'next/server'

// Next's request-scope storages (work-async-storage.external et al.) bind to
// globalThis.AsyncLocalStorage AT MODULE LOAD — miss the window and every
// scope is a Fake that throws on run(). The Next server sets this global in
// its bootstrap; a bare node:test process must do it itself, BEFORE any next
// import executes. That is also why every next import below is dynamic: a
// static one would hoist above this line.
;(globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage }).AsyncLocalStorage ??= AsyncLocalStorage

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // getStripe() runs before signature verification in the webhook route; the
  // key is never sent anywhere in these tests (constructEvent is pure crypto).
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
  // planForPriceId reads env at call time (same wiring as sync-subscription-e2e).
  process.env.STRIPE_PRICE_TEAM = 'price_team_test'
  // Redirect origins must derive from the request, and the topup config test
  // below asserts the unconfigured-price failure mode — clear any shell env.
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.STRIPE_PRICE_TOPUP

  const WEBHOOK_SECRET = 'whsec_route_test_secret'
  // supabase-js derives its storage key from the URL hostname's first dot
  // segment: http://127.0.0.1:<port> → `sb-127-auth-token`.
  const SESSION_COOKIE = 'sb-127-auth-token'

  let prisma: any
  let seedTestOrg: typeof import('@/lib/server/__tests__/test-auth')['seedTestOrg']
  let NextRequest: typeof import('next/server').NextRequest
  let authStub: http.Server
  const orgIds: string[] = []
  const cleanups: Array<() => Promise<void>> = []

  before(async () => {
    ;({ NextRequest } = await import('next/server'))
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))

    // Local stand-in for Supabase auth: supabase-js getClaims() falls back to
    // GET /auth/v1/user for HS256 tokens, and trusts the JWT's claims when
    // that endpoint accepts the token. Echo the token's own subject back so a
    // cookie minted for a seeded user authenticates as that user.
    authStub = http.createServer((req, res) => {
      if (req.url?.startsWith('/auth/v1/user')) {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: payload.sub,
            aud: 'authenticated',
            user_metadata: {},
            app_metadata: { provider: 'email' },
            created_at: new Date().toISOString(),
          }))
        } catch {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid token' }))
        }
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((resolve) => authStub.listen(0, '127.0.0.1', resolve))
    const { port } = authStub.address() as AddressInfo
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  })

  after(async () => {
    for (const fn of cleanups) await fn()
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
    if (authStub) await new Promise((resolve) => authStub.close(resolve))
  })

  async function seedOrg(data: Record<string, unknown> = {}) {
    const org = await prisma.organization.create({
      data: { name: 'StripeRoutes', slug: `stripe-routes-${crypto.randomUUID()}`, ...data },
    })
    orgIds.push(org.id)
    return org
  }

  // ---- Supabase session plumbing for the GET routes ------------------------

  const b64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

  /** Unsigned-but-well-formed HS256 JWT: verification is the stub's job. */
  function sessionCookieFor(supabaseId: string): string {
    const now = Math.floor(Date.now() / 1000)
    const jwt = [
      b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      b64url(JSON.stringify({ sub: supabaseId, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600 })),
      b64url('test-signature'),
    ].join('.')
    return JSON.stringify({
      access_token: jwt,
      refresh_token: 'rt-test',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user: { id: supabaseId, aud: 'authenticated' },
    })
  }

  /**
   * Run fn inside a minimal Next request scope so `cookies()` (and with it the
   * real requireAuth() chain) works outside a Next server. Mirrors the shape
   * cookies() checks for: a work store plus a 'request' work-unit store.
   */
  async function inRequestScope<T>(sessionCookie: string | null, fn: () => Promise<T>): Promise<T> {
    const { workAsyncStorage } = (await import('next/dist/server/app-render/work-async-storage.external')) as any
    const { workUnitAsyncStorage } = (await import('next/dist/server/app-render/work-unit-async-storage.external')) as any
    const { RequestCookies } = (await import('next/dist/server/web/spec-extension/cookies')) as any
    const cookies = new RequestCookies(new Headers())
    if (sessionCookie) cookies.set(SESSION_COOKIE, sessionCookie)
    const workStore = { route: '/api/stripe/test', forceStatic: false, dynamicShouldError: false }
    const workUnitStore = { type: 'request', phase: 'render', cookies, userspaceMutableCookies: cookies, headers: new Headers() }
    return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(workUnitStore, fn))
  }

  const req = (path: string): NextRequestType => new NextRequest(new URL(`http://test${path}`))

  function redirectUrl(res: Response): URL {
    assert.ok(res.status >= 300 && res.status < 400, `expected a redirect, got ${res.status}`)
    const location = res.headers.get('location')
    assert.ok(location, 'redirect carries a Location header')
    return new URL(location)
  }

  // ---- Webhook signature plumbing ------------------------------------------

  /** The real Stripe scheme: v1 = HMAC-SHA256(`${t}.${payload}`, secret), hex. */
  function stripeSignature(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
    return `t=${timestamp},v1=${v1}`
  }

  function webhookRequest(payload: string, signature?: string): NextRequestType {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (signature) headers['stripe-signature'] = signature
    return new NextRequest(new URL('http://test/api/stripe/webhook'), { method: 'POST', body: payload, headers } as never)
  }

  // ---- Webhook -------------------------------------------------------------

  test('POST /api/stripe/webhook fails closed (500) when STRIPE_WEBHOOK_SECRET is missing', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const { POST } = await import('../stripe/webhook/route')
    const payload = JSON.stringify({ id: 'evt_test', type: 'invoice.payment_succeeded', data: { object: {} } })
    // Even a correctly signed request must be refused when there is no secret
    // to verify against — a permissive fallback here would accept forgeries.
    const res = await POST(webhookRequest(payload, stripeSignature(payload, WEBHOOK_SECRET)))
    assert.equal(res.status, 500)
  })

  test('POST /api/stripe/webhook rejects a missing or invalid signature with 400', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    const { POST } = await import('../stripe/webhook/route')
    const payload = JSON.stringify({ id: 'evt_test', type: 'invoice.payment_succeeded', data: { object: {} } })

    const noHeader = await POST(webhookRequest(payload))
    assert.equal(noHeader.status, 400)

    const wrongSecret = await POST(webhookRequest(payload, stripeSignature(payload, 'whsec_wrong_secret')))
    assert.equal(wrongSecret.status, 400)

    // A valid signature over DIFFERENT bytes must not authenticate this body.
    const otherBody = stripeSignature(JSON.stringify({ tampered: true }), WEBHOOK_SECRET)
    const mismatched = await POST(webhookRequest(payload, otherBody))
    assert.equal(mismatched.status, 400)
  })

  test('POST /api/stripe/webhook with a valid signature dispatches customer.subscription.updated to plan sync', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    const { POST } = await import('../stripe/webhook/route')
    const org = await seedOrg({ plan: 'TRIAL' })
    const customerId = `cus_${crypto.randomUUID()}`
    const payload = JSON.stringify({
      id: 'evt_sub_updated',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_route_test',
          object: 'subscription',
          customer: customerId,
          status: 'active',
          items: { data: [{ price: { id: 'price_team_test' } }] },
          trial_end: null,
          metadata: { organizationId: org.id },
        },
      },
    })

    const res = await POST(webhookRequest(payload, stripeSignature(payload, WEBHOOK_SECRET)))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { received: true })

    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.equal(updated.plan, 'PROFESSIONAL')
    assert.equal(updated.stripeSubscriptionId, 'sub_route_test')
    assert.equal(updated.stripeCustomerId, customerId)
  })

  test('POST /api/stripe/webhook with a valid signature stamps firstPaidAt on invoice.payment_succeeded', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    const { POST } = await import('../stripe/webhook/route')
    const customerId = `cus_${crypto.randomUUID()}`
    const org = await seedOrg({ stripeCustomerId: customerId })
    assert.equal(org.firstPaidAt, null)
    const payload = JSON.stringify({
      id: 'evt_invoice_paid',
      object: 'event',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_test', object: 'invoice', amount_paid: 2900, customer: customerId } },
    })

    const res = await POST(webhookRequest(payload, stripeSignature(payload, WEBHOOK_SECRET)))
    assert.equal(res.status, 200)
    const updated = await prisma.organization.findUnique({ where: { id: org.id } })
    assert.ok(updated.firstPaidAt, 'firstPaidAt stamped by the paid invoice')
  })

  // ---- GET routes: unauthenticated -----------------------------------------

  test('the three GETs bounce unauthenticated requests to auth, never into Stripe', async () => {
    const checkout = (await import('../stripe/checkout/route')).GET
    const portal = (await import('../stripe/portal/route')).GET
    const topup = (await import('../stripe/topup/route')).GET

    await inRequestScope(null, async () => {
      const checkoutUrl = redirectUrl(await checkout(req('/api/stripe/checkout?plan=team')))
      assert.equal(checkoutUrl.pathname, '/auth/signup')
      assert.equal(checkoutUrl.searchParams.get('return_to'), '/api/stripe/checkout?plan=team')

      const portalUrl = redirectUrl(await portal(req('/api/stripe/portal')))
      assert.equal(portalUrl.pathname, '/auth/login')
      assert.equal(portalUrl.searchParams.get('return_to'), '/api/stripe/portal')

      const topupUrl = redirectUrl(await topup(req('/api/stripe/topup?packs=2')))
      assert.equal(topupUrl.pathname, '/auth/signup')
      assert.equal(topupUrl.searchParams.get('return_to'), '/api/stripe/topup?packs=2')
    })
  })

  test('GET /api/stripe/checkout without a recognized plan redirects to pricing before auth', async () => {
    const { GET } = await import('../stripe/checkout/route')
    await inRequestScope(null, async () => {
      const url = redirectUrl(await GET(req('/api/stripe/checkout?plan=platinum')))
      assert.equal(`${url.pathname}${url.hash}`, '/#pricing')
    })
  })

  // ---- GET routes: authenticated MEMBER (role gate) ------------------------

  test('canManageBillingByRole grants ADMIN and refuses MEMBER', async () => {
    // The routes' gate, pinned directly: billing:manage is admin-only and not
    // plan-gated, so the role alone decides.
    const { canManageBillingByRole } = await import('@/lib/server/permissions')
    assert.equal(canManageBillingByRole('ADMIN'), true)
    assert.equal(canManageBillingByRole('MEMBER'), false)
  })

  test('the three GETs refuse an authenticated MEMBER with billing_error=forbidden', async () => {
    // Explicit MEMBER (see test-auth.ts): a defaulted seed would run as ADMIN
    // and pass for the wrong reason. The session cookie authenticates through
    // the real requireAuth() chain, so the role the route sees is the DB row's.
    const seeded = await seedTestOrg(prisma, { role: 'MEMBER' })
    cleanups.push(seeded.cleanup)
    const cookie = sessionCookieFor(seeded.auth.dbUser.supabaseId)

    const checkout = (await import('../stripe/checkout/route')).GET
    const portal = (await import('../stripe/portal/route')).GET
    const topup = (await import('../stripe/topup/route')).GET

    await inRequestScope(cookie, async () => {
      for (const [name, run] of [
        ['checkout', () => checkout(req('/api/stripe/checkout?plan=team'))],
        ['portal', () => portal(req('/api/stripe/portal'))],
        ['topup', () => topup(req('/api/stripe/topup'))],
      ] as const) {
        const url = redirectUrl(await run())
        assert.equal(url.pathname, '/settings', name)
        assert.equal(url.searchParams.get('tab'), 'billing', name)
        assert.equal(url.searchParams.get('billing_error'), 'forbidden', name)
      }
    })
  })

  // ---- GET routes: authenticated ADMIN passes the role gate ----------------

  test('GET /api/stripe/portal lets an ADMIN through the role gate (no customer yet → billing tab, no error)', async () => {
    const seeded = await seedTestOrg(prisma, { role: 'ADMIN' })
    cleanups.push(seeded.cleanup)
    const cookie = sessionCookieFor(seeded.auth.dbUser.supabaseId)
    const { GET } = await import('../stripe/portal/route')

    await inRequestScope(cookie, async () => {
      const url = redirectUrl(await GET(req('/api/stripe/portal')))
      // Past the role gate: the seeded org has no stripeCustomerId, so the
      // route lands on the billing tab WITHOUT the forbidden marker — proving
      // the MEMBER refusal above is the role, not a constant.
      assert.equal(url.pathname, '/settings')
      assert.equal(url.searchParams.get('tab'), 'billing')
      assert.equal(url.searchParams.get('billing_error'), null)
    })
  })

  test('GET /api/stripe/checkout for an ADMIN of a grandfathered org redirects to billing before touching Stripe', async () => {
    const seeded = await seedTestOrg(prisma, { role: 'ADMIN' })
    cleanups.push(seeded.cleanup)
    // Grandfathered: the route must bail out to settings before any Stripe
    // call — which is also what keeps this test offline.
    await prisma.organization.update({
      where: { id: seeded.organizationId },
      data: { grandfatheredAt: new Date() },
    })
    const cookie = sessionCookieFor(seeded.auth.dbUser.supabaseId)
    const { GET } = await import('../stripe/checkout/route')

    await inRequestScope(cookie, async () => {
      const url = redirectUrl(await GET(req('/api/stripe/checkout?plan=team')))
      assert.equal(url.pathname, '/settings')
      assert.equal(url.searchParams.get('tab'), 'billing')
      assert.equal(url.searchParams.get('billing_error'), null)
    })
  })

  test('GET /api/stripe/topup for an ADMIN without STRIPE_PRICE_TOPUP fails closed to billing_error=topup', async () => {
    const seeded = await seedTestOrg(prisma, { role: 'ADMIN' })
    cleanups.push(seeded.cleanup)
    const cookie = sessionCookieFor(seeded.auth.dbUser.supabaseId)
    const { GET } = await import('../stripe/topup/route')

    await inRequestScope(cookie, async () => {
      const url = redirectUrl(await GET(req('/api/stripe/topup')))
      assert.equal(url.pathname, '/settings')
      assert.equal(url.searchParams.get('tab'), 'billing')
      assert.equal(url.searchParams.get('billing_error'), 'topup')
    })
  })
} else {
  test('stripe routes e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
