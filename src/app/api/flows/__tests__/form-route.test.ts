/**
 * The public form endpoint, through the real route.
 *
 * This is the only anonymous WRITE path in the product — it starts a run with
 * no session — so the tests that matter are the refusals, not the happy path.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const url = (id: string, token?: string) =>
    new URL(`http://test/api/flows/${id}/form${token ? `?token=${encodeURIComponent(token)}` : ''}`)

  const get = (id: string, token?: string) => new NextRequest(url(id, token), { method: 'GET' } as never)
  const post = (id: string, token: string | undefined, body: unknown) =>
    new NextRequest(url(id, token), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  test('public form route', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { hashToken } = await import('@/lib/crypto/secrets')
    const { GET, POST } = await import('../[id]/form/route')

    const seeded = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    const SECRET = 'form-secret-value'
    const GRAPH = {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
        { id: 'i', type: 'input', position: { x: 0, y: 1 }, data: { params: [{ name: 'email', type: 'string', required: true }] } },
      ],
      edges: [],
    }

    const makeFlow = (over: Record<string, unknown> = {}) =>
      prisma.flow.create({
        data: {
          name: `form-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          status: 'ACTIVE',
          organizationId: seeded.auth.organizationId,
          userId: seeded.auth.dbUser.id,
          graph: GRAPH as never,
          publishedGraph: GRAPH as never,
          trigger: { type: 'form', webhookSecretHash: hashToken(SECRET) } as never,
          ...over,
        },
      })

    await t.test('the form schema is served for a valid token', async () => {
      const flow = await makeFlow()
      const body = await (await GET(get(flow.id, SECRET))).json()
      assert.equal(body.success, true)
      assert.deepEqual(body.fields.map((f: { name: string }) => f.name), ['email'])
    })

    // The graph is workspace-internal; an anonymous caller must not see it.
    await t.test('the schema response does not leak the flow graph', async () => {
      const flow = await makeFlow()
      const raw = JSON.stringify(await (await GET(get(flow.id, SECRET))).json())
      assert.doesNotMatch(raw, /"nodes"/, 'the graph reached an anonymous caller')
    })

    await t.test('a missing token is refused', async () => {
      const flow = await makeFlow()
      assert.equal((await GET(get(flow.id))).status, 401)
    })

    await t.test('a wrong token is refused', async () => {
      const flow = await makeFlow()
      assert.equal((await GET(get(flow.id, 'not-the-secret'))).status, 401)
    })

    // An unknown id and a bad secret must be indistinguishable, or the endpoint
    // becomes an oracle for which flow ids exist.
    await t.test('an unknown flow answers exactly like a bad secret', async () => {
      const flow = await makeFlow()
      const unknown = await GET(get('flw_does_not_exist', SECRET))
      const wrong = await GET(get(flow.id, 'nope'))
      assert.equal(unknown.status, wrong.status)
      assert.deepEqual(await unknown.json(), await wrong.json())
    })

    await t.test('a flow that is not a form is refused even with the right token', async () => {
      const flow = await makeFlow({ trigger: { type: 'webhook', webhookSecretHash: hashToken(SECRET) } as never })
      assert.equal((await GET(get(flow.id, SECRET))).status, 409)
    })

    // The finding a background security review caught: `publishedGraph ?? graph`
    // let a secret holder serve and RUN unreviewed draft edits of a live flow.
    // The webhook trigger route already documented this exact lesson.
    await t.test('an ACTIVE flow with nothing published serves no form', async () => {
      const flow = await makeFlow({ publishedGraph: undefined })
      const response = await GET(get(flow.id, SECRET))
      assert.equal(response.status, 409, 'the unpublished draft was exposed publicly')
    })

    await t.test('an ACTIVE flow with nothing published accepts no submission', async () => {
      const flow = await makeFlow({ publishedGraph: undefined })
      const response = await POST(post(flow.id, SECRET, { email: 'a@b.c' }))
      assert.equal(response.status, 409, 'an unreviewed draft was runnable from a public form')
    })

    // Editing a published form must not change what the public sees until the
    // change is published — the same guarantee agents just got.
    await t.test('a draft edit does not change the public form', async () => {
      const flow = await makeFlow()
      await prisma.flow.updateMany({
        // organizationId is required by the tenant guard — assertions included.
        where: { id: flow.id, organizationId: seeded.auth.organizationId },
        data: { graph: { nodes: [{ id: 'i', type: 'input', position: { x: 0, y: 0 }, data: { params: [{ name: 'ssn', type: 'string' }] } }], edges: [] } as never },
      })
      const body = await (await GET(get(flow.id, SECRET))).json()
      assert.deepEqual(body.fields.map((f: { name: string }) => f.name), ['email'], 'a draft-only field reached the public form')
    })

    await t.test('a DRAFT flow is not publicly reachable', async () => {
      const flow = await makeFlow({ status: 'DRAFT' })
      assert.equal((await GET(get(flow.id, SECRET))).status, 401)
    })

    await t.test('a submission missing a required field is rejected with the field named', async () => {
      const flow = await makeFlow()
      const response = await POST(post(flow.id, SECRET, {}))
      assert.equal(response.status, 400)
      assert.match(JSON.stringify(await response.json()), /email/)
    })

    await t.test('a valid submission starts a run and returns only an acknowledgement', async () => {
      const flow = await makeFlow()
      const response = await POST(post(flow.id, SECRET, { email: 'a@b.c' }))
      const body = await response.json()
      assert.equal(body.success, true)
      // No output: returning it would hand an anonymous caller whatever the
      // flow produced.
      assert.equal(body.output, undefined)
    })

    // Undeclared keys must not ride into the flow's context.
    await t.test('extra fields in a submission do not reach the run', async () => {
      const flow = await makeFlow()
      await POST(post(flow.id, SECRET, { email: 'a@b.c', isAdmin: true }))
      const run = await prisma.flowRun.findFirst({
        where: { flowId: flow.id, organizationId: seeded.auth.organizationId },
        orderBy: { startedAt: 'desc' },
        select: { input: true },
      })
      assert.doesNotMatch(JSON.stringify(run?.input ?? {}), /isAdmin/)
    })
  })
} else {
  test('public form route (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
