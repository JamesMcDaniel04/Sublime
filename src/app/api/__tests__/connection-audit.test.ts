/**
 * Connection LIFECYCLE audit coverage.
 *
 * The compliance question these pin: "who granted third-party access, to which
 * account, with which scopes, and when was it revoked". Every plane that can
 * hold a live grant must answer it — a plane that writes no audit row is a
 * plane an auditor cannot see, which is exactly how OAuth grants went
 * unrecorded while credential CRUD was covered.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'test-encryption-key'

  let prisma: typeof import('@/lib/prisma')['prisma']
  let seeded: { organizationId: string; userId: string; auth: unknown; cleanup: () => Promise<void> }

  const auditRows = async (action: string) =>
    prisma.auditEvent.findMany({
      where: { organizationId: seeded.organizationId, action },
      orderBy: { createdAt: 'desc' },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth as never)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('granting Google access records the scopes and the account it was granted on', async () => {
    const { upsertGoogleConnection } = await import('@/lib/google/store')
    await upsertGoogleConnection({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      service: 'google-calendar',
      accountEmail: 'grant@acme.co',
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
      refreshToken: 'rt-grant',
    })

    const rows = await auditRows('connection.granted')
    const row = rows.find((r) => (r.detail as Record<string, unknown>)?.provider === 'google-calendar')
    assert.ok(row, 'expected a connection.granted audit row for google-calendar')
    const detail = row.detail as Record<string, unknown>
    assert.equal(detail.plane, 'google')
    assert.equal(detail.accountLabel, 'grant@acme.co')
    assert.deepEqual(detail.scopes, ['https://www.googleapis.com/auth/calendar.events'])
    assert.equal(row.actorUserId, seeded.userId)
  })

  test('the refresh token never reaches the Google grant audit row', async () => {
    const rows = await auditRows('connection.granted')
    const serialized = JSON.stringify(rows)
    assert.equal(serialized.includes('rt-grant'), false, 'refresh token leaked into the audit log')
  })

  test('revoking Google access records the revocation an auditor reconciles against the grant', async () => {
    const { upsertGoogleConnection, deleteGoogleConnection } = await import('@/lib/google/store')
    const { id } = await upsertGoogleConnection({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      service: 'google-sheets',
      accountEmail: 'revoke@acme.co',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      refreshToken: 'rt-revoke',
    })
    await deleteGoogleConnection({ organizationId: seeded.organizationId, id, actorUserId: seeded.userId })

    const rows = await auditRows('connection.revoked')
    const row = rows.find((r) => (r.detail as Record<string, unknown>)?.provider === 'google-sheets')
    assert.ok(row, 'expected a connection.revoked audit row for google-sheets')
    assert.equal(row.resourceId, id, 'revoke row must join to the granted connection id')
  })

  test('creating an MCP connection records the grant with its server host', async () => {
    const { POST } = await import('../mcp-connections/route')
    const response = await POST(
      new NextRequest('http://test/api/mcp-connections', {
        method: 'POST',
        body: JSON.stringify({ name: 'Audit MCP', serverUrl: 'https://example.com/mcp-audit/sse', authType: 'none' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 200, await response.text())

    const rows = await auditRows('connection.granted')
    const row = rows.find((r) => (r.detail as Record<string, unknown>)?.plane === 'mcp')
    assert.ok(row, 'expected a connection.granted audit row for the MCP plane')
    assert.equal((row.detail as Record<string, unknown>).serverUrl, 'https://example.com/mcp-audit/sse')
  })

  test('deleting an MCP connection records the revocation', async () => {
    const created = await prisma.mcpConnection.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        name: 'Doomed MCP',
        serverUrl: 'https://example.com/doomed/sse',
        authType: 'none',
      },
    })
    const { DELETE } = await import('../mcp-connections/route')
    const response = await DELETE(
      new NextRequest(`http://test/api/mcp-connections?id=${created.id}`, { method: 'DELETE' }),
    )
    assert.equal(response.status, 200, await response.text())

    const rows = await auditRows('connection.revoked')
    assert.ok(rows.some((r) => r.resourceId === created.id), 'expected a revoke row for the deleted MCP connection')
  })

  test('editing an MCP connection records an update without logging the merged authConfig', async () => {
    const created = await prisma.mcpConnection.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        name: 'Editable MCP',
        serverUrl: 'https://example.com/editable/sse',
        authType: 'none',
      },
    })
    const { PUT } = await import('../mcp-connections/route')
    const response = await PUT(
      new NextRequest('http://test/api/mcp-connections', {
        method: 'PUT',
        body: JSON.stringify({ id: created.id, authType: 'api_key', apiKey: 'sk-should-not-be-logged', headerName: 'X-Key' }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(response.status, 200, await response.text())

    const rows = await auditRows('connection.updated')
    const row = rows.find((r) => r.resourceId === created.id)
    assert.ok(row, 'expected a connection.updated audit row')
    assert.equal(JSON.stringify(row.detail).includes('sk-should-not-be-logged'), false, 'api key leaked into audit detail')
  })
}
