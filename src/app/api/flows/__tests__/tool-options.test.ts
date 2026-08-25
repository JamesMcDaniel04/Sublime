/**
 * DB-backed coverage for POST /api/flows/tool-options — the resource picker.
 *
 * What matters here is the REFUSAL boundary, driven through the real route
 * rather than the pure helper. The picker runs a live tool to fill a dropdown,
 * so the planes it declines are the whole security story, and the plane check
 * must happen BEFORE any executor is resolved — a refusal that only arrives
 * after the tool has been reached is not a refusal.
 *
 * The `flow` case is the one worth the file: that plane reports
 * `isWrite: false` while executing an entire flow, so a route trusting the
 * executor's own flag would run arbitrary side effects to populate a list.
 *
 * Sits inside the TEST_DATABASE_URL gate so the plain unit pass skips it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/flows/tool-options'), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  test('flows tool-options route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { POST } = await import('../tool-options/route')

    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    after(async () => {
      clearTestAuth()
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    // The security-critical one. `flow:<id>` names a real flow the caller can
    // reach; if the plane check did not come first, resolving it would run the
    // flow — mail, Slack, Postgres — just to populate a dropdown.
    await t.test('refuses the flow plane, which would execute a whole flow', async () => {
      const flow = await prisma.flow.create({
        data: { name: 'Picker bait', organizationId: seeded.auth.organizationId, userId: seeded.auth.dbUser.id, status: 'ACTIVE' },
      })
      const body = await (await POST(post({ connectionId: `flow:${flow.id}`, toolName: 'run' }))).json()
      assert.equal(body.success, false)
      assert.match(body.error, /flow/i)
      // It must NOT have run: a refusal that fires the side effect first is
      // not a refusal. No run row is the proof.
      // organizationId is required by the tenant guard, which refuses any
      // org-model query that could span workspaces — assertions included.
      assert.equal(await prisma.flowRun.count({ where: { flowId: flow.id, organizationId: seeded.auth.organizationId } }), 0)
    })

    // An unprefixed id parses as the mcp plane, which reports every tool as
    // read-only regardless of what it does.
    await t.test('refuses the mcp plane, which cannot classify writes', async () => {
      const body = await (await POST(post({ connectionId: 'some-mcp-row-id', toolName: 'list_things' }))).json()
      assert.equal(body.success, false)
      assert.match(body.error, /MCP/i)
    })

    // allowWrites is a property of the connection, not of the statement.
    await t.test('refuses the postgres plane', async () => {
      const body = await (await POST(post({ connectionId: 'postgres:whatever', toolName: 'query' }))).json()
      assert.equal(body.success, false)
      assert.match(body.error, /postgres/i)
    })

    await t.test('rejects a request with no tool name', async () => {
      const response = await POST(post({ connectionId: 'native:slack' }))
      assert.ok(response.status >= 400, `expected a client error, got ${response.status}`)
    })
  })
} else {
  test('flows tool-options route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
