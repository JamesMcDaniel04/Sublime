/**
 * Source control through the real route.
 *
 * GitHub is stubbed at `fetch`; everything else is real — the flows come from
 * Postgres, the plan comes from the real planner, and a pull writes real rows.
 *
 * The properties worth pinning are the ones that decide whether this is safe
 * to hand someone: a push of unchanged flows does nothing, a pull creates
 * DRAFTS rather than activating automation, and the token is never readable
 * back out.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key'

  const req = (body?: unknown) =>
    new NextRequest(new URL('http://test/api/settings/source-control'), {
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    } as never)

  test('source control', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET, POST } = await import('../route')
    const { flowFileContent, flowFilePath } = await import('@/lib/source-control/flow-file')

    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    /** The stubbed repository: path -> content. */
    const repo = new Map<string, string>()
    const writes: string[] = []
    const realFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

      if (url.includes('/branches/')) return json({ name: 'main' })

      if (url.includes('/git/trees/')) {
        return json({
          tree: [...repo.keys()].map((path) => ({ path, type: 'blob', sha: `sha-${path}` })),
        })
      }

      if (url.includes('/git/blobs/')) {
        const sha = decodeURIComponent(url.split('/git/blobs/')[1])
        const path = sha.replace(/^sha-/, '')
        const content = repo.get(path)
        if (content === undefined) return json({}, 404)
        return json({ encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') })
      }

      if (url.includes('/contents/')) {
        const path = decodeURIComponent(url.split('/contents/')[1]).split('?')[0]
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) as { content?: string } : {}
        writes.push(`${method} ${path}`)
        if (method === 'DELETE') repo.delete(path)
        else repo.set(path, Buffer.from(body.content ?? '', 'base64').toString('utf8'))
        return json({ content: { path } })
      }

      return json({}, 404)
    }) as typeof globalThis.fetch

    after(async () => {
      globalThis.fetch = realFetch
      clearTestAuth()
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    const flow = await prisma.flow.create({
      data: {
        name: 'Nightly Sync',
        description: 'Syncs things',
        organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id,
        trigger: { type: 'manual' },
        graph: { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }], edges: [] },
        status: 'ACTIVE',
      },
      select: { id: true, name: true, description: true, trigger: true, graph: true },
    })

    await t.test('nothing is connected initially', async () => {
      const body = await (await GET(req())).json()
      assert.equal(body.connected, false)
    })

    await t.test('a repository can be connected', async () => {
      const body = await (await POST(req({ action: 'connect', repo: 'acme/flows', branch: 'main', token: 'ghp_TESTTOKEN' }))).json()
      assert.equal(body.success, true)
      assert.equal(body.repo, 'acme/flows')
    })

    // The token must not be retrievable after storing it.
    await t.test('the access token is never readable back', async () => {
      const body = await (await GET(req())).json()
      assert.equal(body.connected, true)
      assert.ok(!JSON.stringify(body).includes('ghp_TESTTOKEN'), 'the token was returned by the API')

      const organization = await prisma.organization.findFirstOrThrow({ where: { id: seeded.auth.organizationId } })
      assert.ok(
        !JSON.stringify(organization.settings).includes('ghp_TESTTOKEN'),
        'the token was stored in plaintext',
      )
    })

    await t.test('a plan previews without writing anything', async () => {
      const body = await (await POST(req({ action: 'plan', direction: 'push' }))).json()
      assert.equal(body.changes.length, 1)
      assert.equal(body.changes[0].action, 'create')
      assert.equal(writes.length, 0, 'planning wrote to the repository')
    })

    await t.test('pushing writes the flow', async () => {
      const body = await (await POST(req({ action: 'push' }))).json()
      assert.equal(body.applied, 1)
      assert.ok(repo.has(flowFilePath(flow)), 'the flow file was not created')
    })

    // The property the deterministic serializer exists for.
    await t.test('pushing again changes nothing', async () => {
      const before = writes.length
      const body = await (await POST(req({ action: 'push' }))).json()
      assert.equal(body.applied, 0, 'a no-op push wrote to the repository')
      assert.equal(writes.length, before)
    })

    await t.test('an edited flow pushes as an update carrying the sha', async () => {
      await prisma.flow.updateMany({
        where: { id: flow.id, organizationId: seeded.auth.organizationId },
        data: { description: 'now documented' },
      })
      const body = await (await POST(req({ action: 'plan', direction: 'push' }))).json()
      assert.equal(body.changes[0].action, 'update')
      assert.ok(body.changes[0].sha, 'an update was planned without the sha it replaces')
      await POST(req({ action: 'push' }))
    })

    await t.test('a flow only in the repository pulls as a new DRAFT', async () => {
      const incoming = {
        id: 'pulled-flow-1', name: 'From The Repo', description: '',
        trigger: { type: 'manual' }, graph: { nodes: [], edges: [] },
      }
      repo.set(flowFilePath(incoming), flowFileContent(incoming))

      const body = await (await POST(req({ action: 'pull' }))).json()
      assert.equal(body.applied, 1)

      const created = await prisma.flow.findFirstOrThrow({
        where: { id: 'pulled-flow-1', organizationId: seeded.auth.organizationId },
      })
      assert.equal(created.name, 'From The Repo')
      // Load-bearing: a merged pull request must not start running automation.
      assert.equal(created.status, 'DRAFT', 'a pulled flow was activated')
      assert.equal(created.publishedGraph, null, 'a pulled flow was published')
    })

    await t.test('pulling again changes nothing', async () => {
      const body = await (await POST(req({ action: 'pull' }))).json()
      assert.equal(body.applied, 0)
    })

    await t.test('a pull updates the draft graph and leaves the published one alone', async () => {
      const published = { nodes: [{ id: 'published', type: 'trigger', data: {} }], edges: [] }
      await prisma.flow.updateMany({
        where: { id: 'pulled-flow-1', organizationId: seeded.auth.organizationId },
        data: { publishedGraph: published },
      })

      const changed = {
        id: 'pulled-flow-1', name: 'From The Repo', description: 'changed upstream',
        trigger: { type: 'manual' }, graph: { nodes: [], edges: [] },
      }
      repo.set(flowFilePath(changed), flowFileContent(changed))
      await POST(req({ action: 'pull' }))

      const after = await prisma.flow.findFirstOrThrow({
        where: { id: 'pulled-flow-1', organizationId: seeded.auth.organizationId },
      })
      assert.equal(after.description, 'changed upstream')
      assert.deepEqual(after.publishedGraph, published, 'a pull rewrote what production runs')
    })

    await t.test('an unreachable repository is refused at connect time', async () => {
      const previous = globalThis.fetch
      globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof globalThis.fetch
      const response = await POST(req({ action: 'connect', repo: 'acme/missing', branch: 'main', token: 'ghp_X' }))
      globalThis.fetch = previous
      assert.equal(response.status, 400)
    })

    await t.test('a malformed repository name is refused', async () => {
      assert.equal((await POST(req({ action: 'connect', repo: 'not-a-repo', branch: 'main', token: 'ghp_X' }))).status, 400)
    })

    await t.test('disconnecting clears the binding', async () => {
      await POST(req({ action: 'disconnect' }))
      const body = await (await GET(req())).json()
      assert.equal(body.connected, false)
    })

    await t.test('syncing without a connection is refused', async () => {
      assert.equal((await POST(req({ action: 'push' }))).status, 409)
    })

    await t.test('connection and sync are audited', async () => {
      const events = await prisma.auditEvent.findMany({
        where: { organizationId: seeded.auth.organizationId, action: { startsWith: 'source_control.' } },
      })
      const actions = new Set(events.map((e) => e.action))
      assert.ok(actions.has('source_control.connected'))
      assert.ok(actions.has('source_control.pushed'))
      assert.ok(actions.has('source_control.pulled'))
      assert.ok(actions.has('source_control.disconnected'))
    })
  })
} else {
  test('source control (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
