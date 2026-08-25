/**
 * The public API, driven through the real routes with real keys.
 *
 * The properties that matter are all refusals: a key from one workspace must
 * not read another's data, a key without a scope must not act, and a revoked
 * key must stop working immediately. Those are the ways a public API becomes a
 * breach rather than a feature.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const req = (path: string, init?: { method?: string; key?: string; body?: unknown }) =>
    new NextRequest(new URL(`http://test${path}`), {
      method: init?.method ?? 'GET',
      headers: {
        ...(init?.key ? { authorization: `Bearer ${init.key}` } : {}),
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    } as never)

  test('public API', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { generateApiKey } = await import('@/lib/api-keys/keys')
    const { GET: listFlows } = await import('../flows/route')
    const { GET: listAgents } = await import('../agents/route')
    const { POST: manageKeys, GET: getKeys } = await import('../../settings/api-keys/route')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    /** Create a key directly, so route tests do not depend on the admin route. */
    const makeKey = async (org: typeof seeded, scopes: string[], overrides: Record<string, unknown> = {}) => {
      const generated = generateApiKey()
      await prisma.apiKey.create({
        data: {
          organizationId: org.auth.organizationId,
          createdById: org.auth.dbUser.id,
          name: 'test key',
          prefix: generated.prefix,
          hash: generated.hash,
          scopes,
          ...overrides,
        },
      })
      return generated.plaintext
    }

    await prisma.flow.create({
      data: {
        name: 'Public flow', organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id, graph: {}, status: 'ACTIVE',
      },
    })
    await prisma.flow.create({
      data: {
        name: 'Other workspace flow', organizationId: other.auth.organizationId,
        userId: other.auth.dbUser.id, graph: {}, status: 'ACTIVE',
      },
    })

    await t.test('a valid key lists its own workspace flows', async () => {
      const key = await makeKey(seeded, ['flows:read'])
      const body = await (await listFlows(req('/api/v1/flows', { key }))).json()
      assert.equal(body.success, true)
      assert.equal(body.flows.length, 1)
      assert.equal(body.flows[0].name, 'Public flow')
    })

    // The isolation property.
    await t.test('a key never sees another workspace\'s flows', async () => {
      const key = await makeKey(other, ['flows:read'])
      const body = await (await listFlows(req('/api/v1/flows', { key }))).json()
      assert.equal(body.flows.length, 1)
      assert.equal(body.flows[0].name, 'Other workspace flow')
    })

    await t.test('no key is refused', async () => {
      assert.equal((await listFlows(req('/api/v1/flows'))).status, 401)
    })

    await t.test('a made-up key is refused', async () => {
      assert.equal((await listFlows(req('/api/v1/flows', { key: 'sk_sub_aaaaaaaa_nonsense' }))).status, 401)
    })

    // Knowing a real prefix must not be enough — the prefix is public.
    await t.test('a real prefix with the wrong secret is refused', async () => {
      const real = await makeKey(seeded, ['flows:read'])
      const prefix = real.slice(0, real.lastIndexOf('_'))
      assert.equal((await listFlows(req('/api/v1/flows', { key: `${prefix}_wrongsecretwrongsecret` }))).status, 401)
    })

    await t.test('a key without the scope is refused', async () => {
      const key = await makeKey(seeded, ['agents:read'])
      const response = await listFlows(req('/api/v1/flows', { key }))
      assert.equal(response.status, 403)
      assert.match((await response.json()).error, /flows:read/)
    })

    // write implies read, so a sync key can still list.
    await t.test('a write-scoped key can read the same resource', async () => {
      const key = await makeKey(seeded, ['flows:write'])
      assert.equal((await listFlows(req('/api/v1/flows', { key }))).status, 200)
    })

    await t.test('a revoked key stops working', async () => {
      const key = await makeKey(seeded, ['flows:read'], { revokedAt: new Date() })
      assert.equal((await listFlows(req('/api/v1/flows', { key }))).status, 401)
    })

    await t.test('an expired key stops working', async () => {
      const key = await makeKey(seeded, ['flows:read'], { expiresAt: new Date(Date.now() - 1000) })
      assert.equal((await listFlows(req('/api/v1/flows', { key }))).status, 401)
    })

    await t.test('agents are listed with an agents scope', async () => {
      const key = await makeKey(seeded, ['agents:read'])
      assert.equal((await listAgents(req('/api/v1/agents', { key }))).status, 200)
    })

    // ── key management ──────────────────────────────────────────────────────

    await t.test('creating a key returns the plaintext exactly once', async () => {
      installTestAuth(seeded.auth)
      const created = await (await manageKeys(req('/api/settings/api-keys', {
        method: 'POST', body: { action: 'create', name: 'CI', scopes: ['flows:execute'] },
      }))).json()
      assert.equal(created.success, true)
      assert.match(created.plaintext, /^sk_sub_/)

      // It must not be retrievable afterwards.
      const listed = await (await getKeys(req('/api/settings/api-keys'))).json()
      const row = listed.keys.find((k: { id: string }) => k.id === created.key.id)
      assert.ok(row, 'the created key was not listed')
      assert.ok(!JSON.stringify(listed).includes(created.plaintext), 'the plaintext key was retrievable after creation')
    })

    await t.test('the stored hash is never returned', async () => {
      installTestAuth(seeded.auth)
      const listed = await (await getKeys(req('/api/settings/api-keys'))).json()
      assert.ok(!JSON.stringify(listed).includes('"hash"'))
    })

    await t.test('a key with only unknown scopes is refused', async () => {
      installTestAuth(seeded.auth)
      const response = await manageKeys(req('/api/settings/api-keys', {
        method: 'POST', body: { action: 'create', name: 'Bad', scopes: ['not-a-scope'] },
      }))
      assert.equal(response.status, 400)
    })

    await t.test('a key cannot be revoked from another workspace', async () => {
      installTestAuth(seeded.auth)
      const created = await (await manageKeys(req('/api/settings/api-keys', {
        method: 'POST', body: { action: 'create', name: 'Victim', scopes: ['flows:read'] },
      }))).json()

      installTestAuth(other.auth)
      const response = await manageKeys(req('/api/settings/api-keys', {
        method: 'POST', body: { action: 'revoke', id: created.key.id },
      }))
      assert.equal(response.status, 404, 'another workspace revoked a key it does not own')

      // And it still works.
      installTestAuth(seeded.auth)
      assert.equal((await listFlows(req('/api/v1/flows', { key: created.plaintext }))).status, 200)
    })

    await t.test('revoking a key takes effect immediately', async () => {
      installTestAuth(seeded.auth)
      const created = await (await manageKeys(req('/api/settings/api-keys', {
        method: 'POST', body: { action: 'create', name: 'Doomed', scopes: ['flows:read'] },
      }))).json()
      assert.equal((await listFlows(req('/api/v1/flows', { key: created.plaintext }))).status, 200)

      await manageKeys(req('/api/settings/api-keys', { method: 'POST', body: { action: 'revoke', id: created.key.id } }))
      assert.equal((await listFlows(req('/api/v1/flows', { key: created.plaintext }))).status, 401)
    })

    await t.test('key creation and revocation are audited', async () => {
      const events = await prisma.auditEvent.findMany({
        where: { organizationId: seeded.auth.organizationId, action: { startsWith: 'api_key.' } },
      })
      assert.ok(events.some((e) => e.action === 'api_key.created'))
      assert.ok(events.some((e) => e.action === 'api_key.revoked'))
    })
  })
} else {
  test('public API (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
