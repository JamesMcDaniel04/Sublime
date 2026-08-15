/**
 * The verify endpoint is the one place a member can decrypt and FIRE another
 * member's credential outside a run — it was the only decrypt-and-use path
 * with no audit row. Every attempt must now record `credential.used`, success
 * or failure, so "show me everything this key touched" has no blind spot.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key-0123456789abcdef01'

  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: { organizationId: string; userId: string; auth: unknown; cleanup: () => Promise<void> }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    seeded = (await testAuth.seedTestOrg(prisma)) as typeof seeded
    ;(testAuth.installTestAuth as (auth: unknown) => void)(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a failed verify attempt still writes a credential.used audit row', async () => {
    const { POST: createCredential } = await import('@/app/api/credentials/route')
    const created = await createCredential(new NextRequest(new URL('http://test/api/credentials'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Audit probe', type: 'bearer', token: 'sk-audit-probe', allowedDomains: ['acme.com'] }),
    }) as never)
    assert.equal(created.status, 200)
    const credentialId = (await created.json()).credential.id as string

    const { POST: verify } = await import('@/app/api/credentials/[id]/verify/route')
    // 127.0.0.1 fails the SSRF gate before any outbound request — the attempt
    // is what must be audited, not just a success.
    const response = await verify(new NextRequest(new URL(`http://test/api/credentials/${credentialId}/verify`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9/health' }),
    }) as never)
    assert.equal(response.status, 400)

    const audit = await prisma.auditEvent.findFirst({
      where: { organizationId: seeded.organizationId, action: 'credential.used', resourceId: credentialId },
    })
    assert.ok(audit, 'no credential.used audit row for the verify attempt')
    const detail = (audit.detail ?? {}) as Record<string, unknown>
    assert.equal(detail.context, 'verify')
    assert.equal(detail.outcome, 'failed')
    assert.equal(audit.actorUserId, seeded.auth && (seeded.auth as { dbUser: { id: string } }).dbUser.id)
  })
}
