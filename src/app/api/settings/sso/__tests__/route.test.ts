/**
 * SSO configuration through the real route.
 *
 * The property under test is the claimed/verified split. Domain claiming
 * decides where a person's sign-in is ROUTED, so a claim that took effect
 * without proof of control would let any workspace capture a competitor's
 * users. A claimed domain must therefore do NOTHING until DNS proves it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.DOMAIN_VERIFICATION_SECRET = 'test-pepper'

  const req = (method: string, body?: unknown) =>
    new NextRequest(new URL('http://test/api/settings/sso'), {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    } as never)

  test('SSO settings route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET, POST } = await import('../route')
    const { ssoPolicyFor } = await import('@/lib/auth/sso-policy')

    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    await t.test('a workspace starts with no SSO configured', async () => {
      const body = await (await GET(req('GET'))).json()
      assert.equal(body.enforced, false)
      assert.deepEqual(body.domains, [])
      assert.deepEqual(body.pending, [])
    })

    await t.test('claiming a domain returns the record to publish', async () => {
      const body = await (await POST(req('POST', { action: 'claimDomain', domain: 'acme-test.com' }))).json()
      assert.equal(body.success, true)
      assert.equal(body.recordName, '_sublime.acme-test.com')
      assert.match(body.recordValue, /^sublime-domain-verification=/)
    })

    // The load-bearing property: a claim alone must have no effect.
    await t.test('an unverified claim does not route anyone', async () => {
      const body = await (await GET(req('GET'))).json()
      assert.deepEqual(body.domains, [], 'an unverified domain reached the enforced list')
      assert.equal(body.pending.length, 1)

      const organization = await prisma.organization.findFirstOrThrow({ where: { id: seeded.auth.organizationId } })
      const policy = ssoPolicyFor(organization.settings)
      assert.deepEqual(policy.domains, [], 'the policy honoured an unproven claim')
    })

    await t.test('verification fails when the record is absent', async () => {
      const response = await POST(req('POST', { action: 'verifyDomain', domain: 'acme-test.com' }))
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.match(body.error ?? body.message ?? '', /record/i)
    })

    await t.test('a domain cannot be verified before it is claimed', async () => {
      const response = await POST(req('POST', { action: 'verifyDomain', domain: 'never-claimed.com' }))
      assert.equal(response.status, 400)
    })

    await t.test('a public email domain cannot be claimed', async () => {
      const response = await POST(req('POST', { action: 'claimDomain', domain: 'gmail.com' }))
      assert.equal(response.status, 400)
    })

    await t.test('a malformed domain is refused', async () => {
      assert.equal((await POST(req('POST', { action: 'claimDomain', domain: 'not a domain' }))).status, 400)
    })

    // Enforcement without a provider must not take effect — it would leave a
    // workspace nobody can sign into.
    await t.test('enforcement without a provider does not take effect', async () => {
      await POST(req('POST', { action: 'setEnforced', enforced: true }))
      const body = await (await GET(req('GET'))).json()
      assert.equal(body.enforced, false)
      assert.match(body.enforcementBlocked ?? '', /identity provider/i)
    })

    await t.test('enforcement takes effect once a provider is set', async () => {
      await POST(req('POST', { action: 'setProvider', providerId: 'provider-123' }))
      const body = await (await GET(req('GET'))).json()
      assert.equal(body.enforced, true)
      assert.equal(body.providerId, 'provider-123')
    })

    await t.test('a claimed domain can be removed', async () => {
      await POST(req('POST', { action: 'removeDomain', domain: 'acme-test.com' }))
      const body = await (await GET(req('GET'))).json()
      assert.deepEqual(body.pending, [])
    })

    await t.test('configuration changes are audited', async () => {
      const events = await prisma.auditEvent.findMany({
        where: { organizationId: seeded.auth.organizationId, action: { startsWith: 'sso.' } },
      })
      assert.ok(events.length >= 2, 'SSO configuration changes must leave an audit trail')
    })
  })
} else {
  test('SSO settings route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
