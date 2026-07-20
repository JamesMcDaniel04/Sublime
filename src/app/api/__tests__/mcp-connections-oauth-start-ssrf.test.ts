import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

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

  // Regression for the SSRF gap found in the platform security audit: the
  // route used to validate `serverUrl` with a bare `new URL()` parse only,
  // so an internal/metadata host reached discoverAuthServer's outbound fetch
  // unchecked. It must now be rejected the same way the sibling
  // /api/mcp-connections/discover route rejects it.
  test('rejects a private/metadata serverUrl instead of reaching discovery', async () => {
    const { GET } = await import('../mcp-connections/oauth/start/route')
    const response = await GET(
      new NextRequest(
        new URL('http://test/api/mcp-connections/oauth/start?serverUrl=http://169.254.169.254/&name=evil'),
      ),
    )
    assert.ok(response.status >= 300 && response.status < 400, `expected redirect, got ${response.status}`)
    const location = new URL(response.headers.get('location') ?? '', 'http://test')
    assert.equal(location.pathname, '/connections')
    assert.equal(location.searchParams.get('error'), 'oauth_params')
  })

  test('rejects a non-https serverUrl', async () => {
    const { GET } = await import('../mcp-connections/oauth/start/route')
    const response = await GET(
      new NextRequest(new URL('http://test/api/mcp-connections/oauth/start?serverUrl=http://example.com/&name=x')),
    )
    const location = new URL(response.headers.get('location') ?? '', 'http://test')
    assert.equal(location.searchParams.get('error'), 'oauth_params')
  })
} else {
  test('mcp oauth start SSRF guard (skipped: TEST_DATABASE_URL unset)', { skip: true }, () => undefined)
}
