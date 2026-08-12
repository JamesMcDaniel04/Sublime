/**
 * Credentials CRUD against a real Postgres. The invariant every test shares:
 * a secret goes IN through the API and never comes back OUT of it.
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
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key'

  const SECRET = 'sk-vault-secret-xyz'
  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: { organizationId: string; userId: string; auth: unknown; cleanup: () => Promise<void> }
  let installTestAuth: (auth: unknown) => void

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth as (auth: unknown) => void
    seeded = (await testAuth.seedTestOrg(prisma)) as typeof seeded
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/credentials/route')
    return POST(new NextRequest(new URL('http://test/api/credentials'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never)
  }
  const list = async () => {
    const { GET } = await import('@/app/api/credentials/route')
    return GET(new NextRequest(new URL('http://test/api/credentials')) as never)
  }
  const put = async (id: string, body: unknown) => {
    const { PUT } = await import('@/app/api/credentials/[id]/route')
    return PUT(new NextRequest(new URL(`http://test/api/credentials/${id}`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never)
  }
  const get = async (id: string) => {
    const { GET } = await import('@/app/api/credentials/[id]/route')
    return GET(new NextRequest(new URL(`http://test/api/credentials/${id}`)) as never)
  }
  const del = async (id: string) => {
    const { DELETE } = await import('@/app/api/credentials/[id]/route')
    return DELETE(new NextRequest(new URL(`http://test/api/credentials/${id}`), { method: 'DELETE' }) as never)
  }

  test('create → list: the response is redacted, the row is encrypted', async () => {
    const created = await post({ name: 'Acme API', type: 'bearer', token: SECRET, allowedDomains: ['acme.com'] })
    assert.equal(created.status, 200)
    const createdBody = await created.json()
    assert.equal(JSON.stringify(createdBody).includes(SECRET), false, 'POST echoed the secret back')
    assert.deepEqual(createdBody.credential.config, { type: 'bearer', hasToken: true })

    const listed = await (await list()).json()
    assert.equal(JSON.stringify(listed).includes(SECRET), false, 'GET leaked the secret')
    const row = await prisma.credential.findFirstOrThrow({
      where: { id: createdBody.credential.id, organizationId: seeded.organizationId },
      select: { authConfig: true },
    })
    // Stored, but not as plaintext.
    assert.equal(JSON.stringify(row.authConfig).includes(SECRET), false, 'the secret was stored in plaintext')
  })

  test('update preserves an omitted secret and changes metadata', async () => {
    const created = await (await post({ name: 'Keyed', type: 'apiKeyHeader', headerName: 'X-Old', key: SECRET, allowedDomains: ['api.example.com'] })).json()
    const updated = await put(created.credential.id, { name: 'Keyed', headerName: 'X-New' })
    assert.equal(updated.status, 200)
    const body = await updated.json()
    assert.equal(body.credential.config.headerName, 'X-New')
    assert.equal(body.credential.config.hasKey, true)

    // Prove the secret survived by resolving it, the only sanctioned read path.
    const { resolveCredential } = await import('@/lib/credentials/resolve')
    const plan = await resolveCredential({
      credentialId: created.credential.id,
      organizationId: seeded.organizationId,
      requestUrl: 'https://api.example.com/x',
    })
    assert.equal(plan.headers?.['X-New'], SECRET)
  })

  test('a duplicate name in the workspace is a 409', async () => {
    await post({ name: 'Unique one', type: 'bearer', token: 'a', allowedDomains: ['example.com'] })
    const again = await post({ name: 'Unique one', type: 'bearer', token: 'b', allowedDomains: ['example.com'] })
    assert.equal(again.status, 409)
  })

  test('delete removes the row', async () => {
    const created = await (await post({ name: 'Temporary', type: 'bearer', token: 'x', allowedDomains: ['example.com'] })).json()
    assert.equal((await del(created.credential.id)).status, 200)
    const gone = await prisma.credential.findFirst({
      where: { id: created.credential.id, organizationId: seeded.organizationId },
      select: { id: true },
    })
    assert.equal(gone, null)
  })

  test('another org cannot read, update, or delete this credential', async () => {
    const created = await (await post({ name: 'Private to org A', type: 'bearer', token: SECRET, allowedDomains: ['example.com'] })).json()
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const other = (await testAuth.seedTestOrg(prisma)) as typeof seeded
    installTestAuth(other.auth)
    try {
      const { GET } = await import('@/app/api/credentials/[id]/route')
      const read = await GET(new NextRequest(new URL(`http://test/api/credentials/${created.credential.id}`)) as never)
      // 404, not 403 — a cross-org id must not confirm existence.
      assert.equal(read.status, 404)
      assert.equal((await put(created.credential.id, { name: 'hijacked' })).status, 404)
      assert.equal((await del(created.credential.id)).status, 404)
    } finally {
      installTestAuth(seeded.auth)
      await other.cleanup()
    }
  })

  test('a workspace credential is visible and usable by another member of the same org', async () => {
    // Re-assert auth rather than inheriting it: the cross-org test above swaps
    // the acting identity, and a test that depends on another test's teardown
    // ordering fails for reasons that have nothing to do with what it asserts.
    installTestAuth(seeded.auth)
    const created = await (await post({ name: 'Shared with the team', type: 'bearer', token: SECRET, allowedDomains: ['example.com'] })).json()
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    const otherUser = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId: seeded.organizationId,
        isActive: true,
        role: 'MEMBER',
      },
      include: { organization: true },
    })
    installTestAuth(testAuth.makeTestAuthContext({
      organizationId: seeded.organizationId,
      userId: otherUser.supabaseId,
      dbUser: otherUser,
      user: { id: otherUser.supabaseId } as never,
      role: 'MEMBER',
    }))
    try {
      // Listed for the teammate — redacted, with creator attribution.
      const listed = await (await list()).json()
      const row = listed.credentials.find((credential: { id: string }) => credential.id === created.credential.id)
      assert.ok(row, 'same-org member could not see the workspace credential')
      assert.equal(JSON.stringify(listed).includes(SECRET), false, 'workspace list leaked the secret value')

      // Readable, editable, resolvable — and finally deletable — by the teammate.
      assert.equal((await get(created.credential.id)).status, 200)
      assert.equal((await put(created.credential.id, { name: 'Renamed by teammate' })).status, 200)
      const { resolveCredential } = await import('@/lib/credentials/resolve')
      const plan = await resolveCredential({
        credentialId: created.credential.id,
        organizationId: seeded.organizationId,
        requestUrl: 'https://api.example.com/x',
      })
      assert.equal(plan.headers?.authorization, `Bearer ${SECRET}`)
      assert.equal((await del(created.credential.id)).status, 200)
    } finally {
      installTestAuth(seeded.auth)
    }
  })

  test('an unknown credential type is rejected', async () => {
    installTestAuth(seeded.auth)
    // 'digest' was the fixture here until the HTTP-node work made it a real
    // type — use a value that can never join CREDENTIAL_TYPES.
    const bad = await post({ name: 'Bad type', type: 'carrier_pigeon', token: 'x', allowedDomains: ['example.com'] })
    assert.notEqual(bad.status, 200)
  })

  test('a nameless credential is rejected', async () => {
    installTestAuth(seeded.auth)
    assert.notEqual((await post({ name: '', type: 'bearer', token: 'x', allowedDomains: ['example.com'] })).status, 200)
  })

  // ── MCP connections backed by a vault credential ───────────────────────────

  test('an MCP connection pointing at a credential resolves to its injected header', async () => {
    installTestAuth(seeded.auth)
    const created = await (await post({
      name: 'MCP key',
      type: 'apiKeyHeader',
      headerName: 'X-Api-Key',
      key: SECRET,
      allowedDomains: ['mcp.example.com'],
    })).json()
    assert.equal(created.success, true, JSON.stringify(created))

    const { mcpCredentialPlan } = await import('@/lib/mcp/connection-credential')
    const plan = await mcpCredentialPlan(
      {
        serverUrl: 'https://mcp.example.com/rpc',
        authType: 'api_key',
        authConfig: { credentialId: created.credential.id },
      },
      { organizationId: seeded.organizationId },
    )
    // The same header an inline api_key would have produced — one saved key,
    // now reusable by any MCP server or HTTP step on an allowed domain.
    assert.deepEqual(plan?.headers, { 'X-Api-Key': SECRET })
  })

  test('a credential whose allow-list excludes the MCP host is refused', async () => {
    installTestAuth(seeded.auth)
    const created = await (await post({
      name: 'Scoped elsewhere',
      type: 'apiKeyHeader',
      headerName: 'X-Api-Key',
      key: SECRET,
      allowedDomains: ['other.example.com'],
    })).json()

    const { mcpCredentialPlan } = await import('@/lib/mcp/connection-credential')
    // Fail closed and loudly: calling the server unauthenticated would read as
    // a server-side permission bug rather than a misconfigured credential.
    await assert.rejects(
      () => mcpCredentialPlan(
        { serverUrl: 'https://mcp.example.com/rpc', authType: 'api_key', authConfig: { credentialId: created.credential.id } },
        { organizationId: seeded.organizationId },
      ),
      /not allowed for that request URL/,
    )
  })
}
