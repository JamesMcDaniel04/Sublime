/**
 * Workspace variables through the real route.
 *
 * Two things matter more than CRUD here:
 *
 *  1. The credential guard runs SERVER-SIDE. The UI is not the only write
 *     path, and a plaintext table that quietly accumulates API tokens would be
 *     worse than not having variables at all — it would look like a vault
 *     without any of the vault's reveal control, rotation or audit.
 *  2. Reads are open to members, writes are not. A variable is shared state:
 *     changing `sales_channel` changes every flow that reads it, including
 *     flows the editor does not own.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const req = (method: string, body?: unknown) =>
    new NextRequest(new URL('http://test/api/workspace-variables'), {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    } as never)

  test('workspace variables route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET, PUT, DELETE } = await import('../route')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    await t.test('a variable can be created and read back', async () => {
      const put = await (await PUT(req('PUT', { key: 'sales_channel', value: 'C123' }))).json()
      assert.equal(put.success, true)
      assert.equal(put.variable.key, 'sales_channel')

      const list = await (await GET(req('GET'))).json()
      assert.ok(list.variables.some((v: { key: string; value: string }) => v.key === 'sales_channel' && v.value === 'C123'))
    })

    await t.test('writing the same key updates rather than duplicating', async () => {
      await PUT(req('PUT', { key: 'sales_channel', value: 'C999' }))
      const list = await (await GET(req('GET'))).json()
      const matches = list.variables.filter((v: { key: string }) => v.key === 'sales_channel')
      assert.equal(matches.length, 1, 'the unique index should have made this an update')
      assert.equal(matches[0].value, 'C999')
    })

    await t.test('a key is normalized before storage', async () => {
      await PUT(req('PUT', { key: '  Region_Code  ', value: 'emea' }))
      const list = await (await GET(req('GET'))).json()
      assert.ok(list.variables.some((v: { key: string }) => v.key === 'region_code'))
    })

    // The guard that keeps this from becoming a secrets store.
    await t.test('a credential-shaped key is refused, pointing at the vault', async () => {
      const response = await PUT(req('PUT', { key: 'api_key', value: 'sk-live-xxx' }))
      const body = await response.json()
      assert.equal(body.success, false)
      assert.match(JSON.stringify(body), /vault|credential/i)
    })

    await t.test('the refusal is not overzealous', async () => {
      const body = await (await PUT(req('PUT', { key: 'tokens_per_batch', value: '50' }))).json()
      assert.equal(body.success, true, 'an innocent key containing "token" should be allowed')
    })

    await t.test('a dotted key is refused — the token grammar cannot parse it', async () => {
      const body = await (await PUT(req('PUT', { key: 'sales.channel', value: 'x' }))).json()
      assert.equal(body.success, false)
    })

    // Tenant isolation: the org filter is what stops one workspace reading or
    // deleting another's constants.
    await t.test('another workspace sees none of these', async () => {
      installTestAuth(other.auth)
      const list = await (await GET(req('GET'))).json()
      assert.equal(list.variables.length, 0)
      installTestAuth(seeded.auth)
    })

    await t.test('deleting a key removes it', async () => {
      await DELETE(req('DELETE', { key: 'region_code' }))
      const list = await (await GET(req('GET'))).json()
      assert.ok(!list.variables.some((v: { key: string }) => v.key === 'region_code'))
    })

    await t.test('deleting an unknown key is a 404, not a 500', async () => {
      const response = await DELETE(req('DELETE', { key: 'never_existed' }))
      assert.equal(response.status, 404)
    })
  })
} else {
  test('workspace variables route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
