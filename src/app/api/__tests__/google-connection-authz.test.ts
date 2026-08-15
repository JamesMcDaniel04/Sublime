/**
 * Google connections are PERSONAL grants (schema unique includes userId), but
 * the disconnect route was org-scoped only — any member could delete (and
 * thereby revoke) a colleague's Google account connection. Deleting someone
 * else's grant is a cross-owner act: owner or audited admin elevation only.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key-0123456789abcdef01'

  let prisma: typeof import('@/lib/prisma').prisma
  let testAuth: typeof import('@/lib/server/__tests__/test-auth')
  let seeded: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let member: { id: string; supabaseId: string }

  // Undecryptable on purpose: the route's best-effort revoke leg must skip the
  // network call instead of reaching Google from a unit test.
  const GARBAGE_ENC = 'v2:AAAA:AAAA:AAAA:AAAA'

  const seedConnection = async (ownerUserId: string) =>
    prisma.googleOAuthConnection.create({
      data: {
        organizationId: seeded.organizationId,
        userId: ownerUserId,
        service: 'google-mail',
        accountEmail: `${crypto.randomUUID()}@example.com`,
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
        refreshTokenEnc: GARBAGE_ENC,
      },
    })

  const deleteConnection = async (id: string) => {
    const { DELETE } = await import('@/app/api/google/oauth/connections/[id]/route')
    return DELETE(new NextRequest(new URL(`http://test/api/google/oauth/connections/${id}`), { method: 'DELETE' }) as never)
  }

  const authFor = (user: { id: string; supabaseId: string }, role: 'ADMIN' | 'MEMBER') =>
    testAuth.makeTestAuthContext({
      organizationId: seeded.organizationId,
      userId: user.supabaseId,
      dbUser: user as never,
      user: { id: user.supabaseId } as never,
      role,
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    testAuth = await import('@/lib/server/__tests__/test-auth')
    seeded = await testAuth.seedTestOrg(prisma)
    member = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a member cannot delete another member\'s Google connection', async () => {
    const adminDbUser = (seeded.auth as { dbUser: { id: string; supabaseId: string } }).dbUser
    const connection = await seedConnection(adminDbUser.id)
    testAuth.installTestAuth(authFor(member, 'MEMBER'))
    const response = await deleteConnection(connection.id)
    assert.equal(response.status, 403)
    const survivor = await prisma.googleOAuthConnection.findFirst({
      where: { id: connection.id, organizationId: seeded.organizationId },
    })
    assert.ok(survivor, 'the connection was deleted despite the refusal')
  })

  test('the owner deletes their own connection without elevation', async () => {
    const connection = await seedConnection(member.id)
    testAuth.installTestAuth(authFor(member, 'MEMBER'))
    const response = await deleteConnection(connection.id)
    assert.equal(response.status, 200)
    assert.equal(
      await prisma.googleOAuthConnection.count({ where: { id: connection.id, organizationId: seeded.organizationId } }),
      0,
    )
  })

  test('an admin deletes a member\'s connection — elevated and audited', async () => {
    const connection = await seedConnection(member.id)
    testAuth.installTestAuth(seeded.auth as never)
    const response = await deleteConnection(connection.id)
    assert.equal(response.status, 200)
    assert.equal(
      await prisma.googleOAuthConnection.count({ where: { id: connection.id, organizationId: seeded.organizationId } }),
      0,
    )
    // withElevatedAccess fires its audit write without awaiting it (by
    // design: the write must never block the action) — poll briefly.
    let audit = null
    for (let attempt = 0; attempt < 20 && !audit; attempt += 1) {
      audit = await prisma.auditEvent.findFirst({
        where: { organizationId: seeded.organizationId, action: 'admin.resource.update', resourceId: connection.id },
      })
      if (!audit) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(audit, 'cross-owner delete left no elevation audit row')
  })
}
