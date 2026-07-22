import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/api/google/oauth/callback'

  let prisma: typeof import('@/lib/prisma')['prisma']
  let seeded: { organizationId: string; userId: string; auth: unknown; cleanup: () => Promise<void> }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth as never)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('start route redirects to Google with a signed state', async () => {
    const { GET } = await import('../google/oauth/start/route')
    const response = await GET(new NextRequest(new URL('http://test/api/google/oauth/start?service=google-mail')))
    assert.ok(response.status >= 300 && response.status < 400, `expected redirect, got ${response.status}`)
    const location = new URL(response.headers.get('location') ?? '')
    assert.equal(location.hostname, 'accounts.google.com')
    const { verifyState } = await import('@/lib/google/oauth')
    const state = verifyState(location.searchParams.get('state') ?? '')
    assert.equal(state?.organizationId, seeded.organizationId)
    assert.equal(state?.service, 'google-mail')
    // Must be the DB user id (dbUser.id), NOT auth.userId (the Supabase id):
    // the callback persists this into the connection rows, and the status
    // route queries them by dbUser.id — a mismatch stores the connection
    // under an id no reader ever queries, so the UI shows "Not connected".
    assert.equal(state?.userId, seeded.userId)
  })

  test('status route reports a stored native connection as connected', async () => {
    const { upsertGoogleConnection } = await import('@/lib/google/store')
    await upsertGoogleConnection({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      service: 'google-mail',
      accountEmail: 'status@b.co',
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      refreshToken: 'rt-status',
    })
    const { GET } = await import('../nango/status/route')
    const response = await GET(new NextRequest(new URL('http://test/api/nango/status')))
    const body = (await response.json()) as { connections?: Record<string, { connected: boolean; native?: boolean }> }
    assert.equal(body.connections?.['google-mail']?.connected, true)
    assert.equal(body.connections?.['google-mail']?.native, true)
  })

  test('start route accepts every registered Google service', async () => {
    const { GET } = await import('../google/oauth/start/route')
    for (const service of ['google-calendar', 'google-sheets', 'google-drive']) {
      const response = await GET(new NextRequest(new URL(`http://test/api/google/oauth/start?service=${service}`)))
      assert.equal(response.status, 307, service)
      assert.ok((response.headers.get('location') ?? '').startsWith('https://accounts.google.com/'), service)
    }
  })

  test('start route rejects unknown services', async () => {
    const { GET } = await import('../google/oauth/start/route')
    const response = await GET(new NextRequest(new URL('http://test/api/google/oauth/start?service=google-docs')))
    assert.equal(response.status, 400)
  })

  test('callback with forged state redirects to integrations error', async () => {
    const { GET } = await import('../google/oauth/callback/route')
    const response = await GET(new NextRequest(new URL('http://test/api/google/oauth/callback?code=x&state=forged')))
    const location = response.headers.get('location') ?? ''
    assert.ok(location.includes('/integrations?error=invalid_state'), location)
  })

  test('disconnect deletes the record and its mirror row', async () => {
    const { upsertGoogleConnection } = await import('@/lib/google/store')
    const { id } = await upsertGoogleConnection({
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      service: 'google-mail',
      accountEmail: 'a@b.co',
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      refreshToken: 'rt-1',
    })
    const mirrors = await prisma.nangoConnection.findMany({
      where: { organizationId: seeded.organizationId, connectionId: id },
    })
    assert.equal(mirrors.length, 1)
    assert.equal(mirrors[0].provider, 'google-native')

    const { DELETE } = await import('../google/oauth/connections/[id]/route')
    const response = await DELETE(new NextRequest(new URL(`http://test/api/google/oauth/connections/${id}`), { method: 'DELETE' }))
    assert.equal(response.status, 200)
    assert.equal(
      await prisma.googleOAuthConnection.findFirst({ where: { id, organizationId: seeded.organizationId } }),
      null,
    )
    assert.equal(
      (await prisma.nangoConnection.findMany({ where: { organizationId: seeded.organizationId, connectionId: id } })).length,
      0,
    )
  })
} else {
  test('google oauth route smoke (skipped: TEST_DATABASE_URL unset)', { skip: true }, () => undefined)
}
