/**
 * Member deactivation previously flipped isActive and signed the user out —
 * and left every one of their live grants (Google refresh tokens, Nango
 * connections, Slack bot tokens, personal MCP servers) fully usable. The
 * OWASP offboarding requirement is revocation, not just lockout: deactivating
 * a member must sweep their personal connections on every plane.
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
  // No NANGO_SECRET_KEY: the Nango leg must delete local rows without
  // attempting an external call.
  delete process.env.NANGO_SECRET_KEY

  // Undecryptable ciphertexts so revocation legs skip their network calls.
  const GARBAGE_ENC = 'v2:AAAA:AAAA:AAAA:AAAA'
  const GARBAGE_JSON = { value: GARBAGE_ENC }

  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let member: { id: string; supabaseId: string }
  let adminRows: { googleId: string }
  let memberRows: { googleId: string; nangoId: string; slackId: string; mcpId: string }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    seeded = await testAuth.seedTestOrg(prisma)
    testAuth.installTestAuth(seeded.auth)
    member = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
    })
    const organizationId = seeded.organizationId
    const adminId = (seeded.auth as { dbUser: { id: string } }).dbUser.id

    const adminGoogle = await prisma.googleOAuthConnection.create({
      data: {
        organizationId, userId: adminId, service: 'google-mail',
        accountEmail: 'admin@example.com', scopes: [], refreshTokenEnc: GARBAGE_ENC,
      },
    })
    adminRows = { googleId: adminGoogle.id }

    const google = await prisma.googleOAuthConnection.create({
      data: {
        organizationId, userId: member.id, service: 'google-calendar',
        accountEmail: 'member@example.com', scopes: [], refreshTokenEnc: GARBAGE_ENC,
      },
    })
    const nango = await prisma.nangoConnection.create({
      data: { organizationId, userId: member.id, connectionId: `conn-${crypto.randomUUID()}`, providerConfigKey: 'slack' },
    })
    const slack = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId, userId: member.id, teamId: `T${crypto.randomUUID().slice(0, 8)}`, botUserId: 'U-offboard-bot',
        botToken: GARBAGE_JSON, signingSecret: GARBAGE_JSON, status: 'active',
      },
    })
    const mcp = await prisma.mcpConnection.create({
      data: {
        organizationId, userId: member.id, name: 'personal-server',
        serverUrl: 'https://mcp.example.com', authType: 'api_key', authConfig: { apiKey: GARBAGE_ENC },
      },
    })
    memberRows = { googleId: google.id, nangoId: nango.id, slackId: slack.id, mcpId: mcp.id }
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('deactivating a member revokes their personal connections on every plane', async () => {
    const { PATCH } = await import('@/app/api/settings/members/route')
    // Supabase admin signOut has no env in this harness and may fail AFTER the
    // sweep — the DB state is the assertion, not the response status.
    await PATCH(new NextRequest(new URL('http://test/api/settings/members'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: member.id, isActive: false }),
    }) as never).catch(() => undefined)

    const organizationId = seeded.organizationId
    assert.equal(await prisma.googleOAuthConnection.count({ where: { organizationId, id: memberRows.googleId } }), 0, 'google grant survived offboarding')
    assert.equal(await prisma.nangoConnection.count({ where: { organizationId, id: memberRows.nangoId } }), 0, 'nango connection survived offboarding')
    assert.equal(await prisma.slackWorkspaceConnection.count({ where: { organizationId, id: memberRows.slackId } }), 0, 'slack binding survived offboarding')
    assert.equal(await prisma.mcpConnection.count({ where: { organizationId, id: memberRows.mcpId } }), 0, 'personal MCP connection survived offboarding')

    // Another member's grants are untouched.
    assert.equal(await prisma.googleOAuthConnection.count({ where: { organizationId, id: adminRows.googleId } }), 1, 'sweep crossed user boundaries')

    // Each revocation is on the audit record.
    const revoked = await prisma.auditEvent.findMany({
      where: { organizationId, action: 'connection.revoked', createdAt: { gte: new Date(Date.now() - 60_000) } },
    })
    assert.ok(revoked.length >= 4, `expected >=4 connection.revoked audit rows, got ${revoked.length}`)
  })
}
