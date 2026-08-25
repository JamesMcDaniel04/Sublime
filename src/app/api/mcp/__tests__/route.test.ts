/**
 * The workspace as an MCP server, driven the way a real client drives it:
 * initialize, tools/list, tools/call — over the real route, with real flows in
 * Postgres.
 *
 * The properties that decide whether this is safe to expose: a flow is
 * invisible until it opts in, a key from another workspace sees nothing, and
 * an unpublished flow is never runnable from outside.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * What Next passes as a route handler's second argument. Supplied here because
 * the wrapper's type requires it — omitting it is what let a signature
 * mismatch reach `next build` while every test passed.
 */
const ROUTE_CONTEXT = { params: Promise.resolve({} as Record<string, string>) }

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const rpc = (key: string, body: unknown) =>
    new NextRequest(new URL('http://test/api/mcp'), {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } as never)

  test('MCP server', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { generateApiKey } = await import('@/lib/api-keys/keys')
    const { MCP_PROTOCOL_VERSION } = await import('@/lib/mcp/server-protocol')
    const { POST, GET } = await import('../route')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const makeKey = async (org: typeof seeded, scopes: string[]) => {
      const generated = generateApiKey()
      await prisma.apiKey.create({
        data: {
          organizationId: org.auth.organizationId, createdById: org.auth.dbUser.id,
          name: 'mcp', prefix: generated.prefix, hash: generated.hash, scopes,
        },
      })
      return generated.plaintext
    }

    const key = await makeKey(seeded, ['flows:execute'])
    const otherKey = await makeKey(other, ['flows:execute'])

    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'in', type: 'input', data: { params: [{ name: 'account', type: 'string', required: true }] } },
      ],
      edges: [{ id: 'e0', source: 'trigger', target: 'in' }],
    }

    const exposed = await prisma.flow.create({
      data: {
        name: 'Nightly Sync', description: 'Syncs things',
        organizationId: seeded.auth.organizationId, userId: seeded.auth.dbUser.id,
        trigger: { type: 'manual' }, graph, publishedGraph: graph,
        status: 'ACTIVE', metadata: { mcpExposed: true },
      },
      select: { id: true },
    })

    // Present but not opted in.
    await prisma.flow.create({
      data: {
        name: 'Private Flow', description: 'not for outsiders',
        organizationId: seeded.auth.organizationId, userId: seeded.auth.dbUser.id,
        trigger: { type: 'manual' }, graph, publishedGraph: graph, status: 'ACTIVE',
      },
    })

    await t.test('initialize completes the handshake', async () => {
      const body = await (await POST(rpc(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), ROUTE_CONTEXT)).json()
      assert.equal(body.result.protocolVersion, MCP_PROTOCOL_VERSION)
      assert.ok(body.result.capabilities.tools)
    })

    await t.test('a notification is accepted with no body', async () => {
      const response = await POST(rpc(key, { jsonrpc: '2.0', method: 'notifications/initialized' }), ROUTE_CONTEXT)
      assert.equal(response.status, 202)
      assert.equal(await response.text(), '')
    })

    await t.test('tools/list shows only the flow that opted in', async () => {
      const body = await (await POST(rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), ROUTE_CONTEXT)).json()
      assert.equal(body.result.tools.length, 1, 'a flow that never opted in was exposed')
      assert.match(body.result.tools[0].name, /nightly/)
      assert.deepEqual(body.result.tools[0].inputSchema.required, ['account'])
    })

    await t.test('the internal flow id is never sent to the client', async () => {
      const body = await (await POST(rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), ROUTE_CONTEXT)).json()
      assert.ok(!JSON.stringify(body).includes(exposed.id))
    })

    // The isolation property.
    await t.test('another workspace sees none of these tools', async () => {
      const body = await (await POST(rpc(otherKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), ROUTE_CONTEXT)).json()
      assert.deepEqual(body.result.tools, [])
    })

    await t.test('an unpublished flow is not exposed even when it opts in', async () => {
      const draft = await prisma.flow.create({
        data: {
          name: 'Draft Only', organizationId: seeded.auth.organizationId, userId: seeded.auth.dbUser.id,
          trigger: { type: 'manual' }, graph, publishedGraph: undefined,
          status: 'DRAFT', metadata: { mcpExposed: true },
        },
        select: { id: true },
      })
      const body = await (await POST(rpc(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), ROUTE_CONTEXT)).json()
      assert.ok(
        !body.result.tools.some((tool: { name: string }) => tool.name.includes('draft')),
        'an unpublished flow was runnable from outside',
      )
      await prisma.flow.deleteMany({ where: { id: draft.id, organizationId: seeded.auth.organizationId } })
    })

    await t.test('tools/call runs the flow', async () => {
      const body = await (await POST(rpc(key, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'nightly_sync', arguments: { account: 'acme' } },
      }), ROUTE_CONTEXT)).json()
      assert.equal(body.result.isError, false, `the call failed: ${JSON.stringify(body.result)}`)

      const run = await prisma.flowRun.findFirst({
        where: { flowId: exposed.id, organizationId: seeded.auth.organizationId },
      })
      assert.ok(run, 'no run was recorded for the MCP call')
    })

    await t.test('an unknown tool is a tool error, not a broken session', async () => {
      const body = await (await POST(rpc(key, {
        jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool' },
      }), ROUTE_CONTEXT)).json()
      assert.equal(body.result.isError, true)
      assert.equal(body.error, undefined)
    })

    // A tool from another workspace must not be callable by name either.
    await t.test('a tool cannot be called across workspaces by name', async () => {
      const body = await (await POST(rpc(otherKey, {
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nightly_sync', arguments: {} },
      }), ROUTE_CONTEXT)).json()
      assert.equal(body.result.isError, true, 'another workspace ran a flow it cannot see')
    })

    await t.test('a malformed body returns a JSON-RPC error, not a crash', async () => {
      const response = await POST(rpc(key, 'not an object'), ROUTE_CONTEXT)
      assert.equal(response.status, 200, 'a bad request must not fail the transport')
      assert.equal((await response.json()).error.code, -32600)
    })

    await t.test('no key is refused', async () => {
      const response = await POST(new NextRequest(new URL('http://test/api/mcp'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      } as never), ROUTE_CONTEXT)
      assert.equal(response.status, 401)
    })

    await t.test('a key without flows:execute cannot reach the server', async () => {
      const readOnly = await makeKey(seeded, ['flows:read'])
      assert.equal((await POST(rpc(readOnly, { jsonrpc: '2.0', id: 1, method: 'tools/list' }), ROUTE_CONTEXT)).status, 403)
    })

    await t.test('GET says to use POST rather than pretending to stream', async () => {
      const response = await GET(new NextRequest(new URL('http://test/api/mcp'), {
        method: 'GET', headers: { authorization: `Bearer ${key}` },
      } as never), ROUTE_CONTEXT)
      assert.equal(response.status, 405)
      assert.equal(response.headers.get('allow'), 'POST')
    })
  })
} else {
  test('MCP server (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
