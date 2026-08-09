/**
 * End-to-end drives of the credential vault and the Code/HTTP steps through
 * their REAL route handlers against a real Postgres (route-smoke protocol).
 * Only the outbound network is stubbed — at the global fetch boundary — so
 * every layer in between (zod, auth, tenant scoping, encryption, the
 * originalName merge, credential injection, the vm/pyodide engines, run
 * persistence) is the production code path.
 *
 * Run: TEST_DATABASE_URL=postgres://... npx tsx --test <this file>
 */
import type { Prisma } from '@/generated/prisma/client'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'e2e-test-key'

  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let flowId: string

  // ── Outbound network stub ─────────────────────────────────────────────────
  // Everything else is real. Records each request so assertions can prove
  // what actually went over the wire (e.g. the injected credential header).
  const realFetch = globalThis.fetch
  type Sent = { url: string; headers: Record<string, string> }
  const sent: Sent[] = []
  let respond: (url: string) => Response = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const flow = await prisma.flow.create({
      data: { name: 'E2E flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    flowId = flow.id
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (!url.includes('example.com')) return realFetch(input as RequestInfo, init)
      const headers: Record<string, string> = {}
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) => { headers[key] = value })
      sent.push({ url, headers })
      return respond(url)
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (seeded) await seeded.cleanup()
  })

  const jsonReq = (path: string, method: string, body?: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    })

  let credentialId = ''

  // ── WS1: the credential lifecycle through the real routes ─────────────────

  test('create a custom credential through POST /api/credentials', async () => {
    const { POST } = await import('../credentials/route')
    const response = await POST(jsonReq('/api/credentials', 'POST', {
      name: 'Acme custom',
      type: 'custom',
      allowedDomains: ['example.com'],
      headers: [{ name: 'X-Api-Key', value: 'secret-one' }, { name: 'X-Drop-Me', value: 'secret-two' }],
    }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    credentialId = body.credential.id
    // Redacted: names visible, never a value.
    assert.deepEqual(body.credential.config.headers, [
      { name: 'X-Api-Key', hasValue: true },
      { name: 'X-Drop-Me', hasValue: true },
    ])
    assert.equal(JSON.stringify(body).includes('secret-one'), false, 'no secret in the response')
  })

  test('rename + delete custom entries through PUT — stored secret survives the rename', async () => {
    const { PUT } = await import('../credentials/[id]/route')
    const response = await PUT(jsonReq(`/api/credentials/${credentialId}`, 'PUT', {
      type: 'custom',
      // The editor's exact wire shape: renamed row keeps no value (meaning
      // "keep stored"), carries originalName; X-Drop-Me is simply absent.
      headers: [{ name: 'X-Renamed', originalName: 'X-Api-Key' }],
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.credential.config.headers, [{ name: 'X-Renamed', hasValue: true }])

    // Server-side proof the rename kept the SECRET, not just the name: the
    // resolver (org-scoped, decrypting) must inject the original value under
    // the new header name.
    const { resolveCredential } = await import('@/lib/credentials/resolve')
    const plan = await resolveCredential({
      credentialId,
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      requestUrl: 'https://example.com/things',
    })
    assert.deepEqual(plan.headers, { 'X-Renamed': 'secret-one' })
  })

  test('the verify route sends the injected header and records verified state', async () => {
    sent.length = 0
    const { POST } = await import('../credentials/[id]/verify/route')
    const response = await POST(jsonReq(`/api/credentials/${credentialId}/verify`, 'POST', {
      url: 'https://example.com/health',
      method: 'GET',
    }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.verification.state, 'verified')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].headers['x-renamed'], 'secret-one', 'the credential header reached the wire')

    const { GET } = await import('../credentials/route')
    const list = await (await GET(jsonReq('/api/credentials', 'GET'))).json()
    const row = list.credentials.find((candidate: { id: string }) => candidate.id === credentialId)
    assert.equal(row.verification.state, 'verified', 'the list surfaces the recorded state')
  })

  test('a rejected credential records failed state and returns the reason', async () => {
    respond = () => new Response('nope', { status: 401 })
    const { POST } = await import('../credentials/[id]/verify/route')
    const response = await POST(jsonReq(`/api/credentials/${credentialId}/verify`, 'POST', {
      url: 'https://example.com/health',
      method: 'GET',
    }))
    respond = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    assert.equal(response.status, 400)

    const { GET } = await import('../credentials/route')
    const list = await (await GET(jsonReq('/api/credentials', 'GET'))).json()
    const row = list.credentials.find((candidate: { id: string }) => candidate.id === credentialId)
    assert.equal(row.verification.state, 'failed')
    assert.match(row.verification.error ?? '', /401/)
  })

  test('a domain-scoped credential refuses verification against another host', async () => {
    const { POST: create } = await import('../credentials/route')
    const scoped = await (await create(jsonReq('/api/credentials', 'POST', {
      name: 'Scoped bearer', type: 'bearer', token: 'tok-1', allowedDomains: ['acme.internal-only.com'],
    }))).json()
    const { POST: verify } = await import('../credentials/[id]/verify/route')
    const response = await verify(jsonReq(`/api/credentials/${scoped.credential.id}/verify`, 'POST', {
      url: 'https://example.com/health',
      method: 'GET',
    }))
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.match(body.error ?? '', /not allowed/i)
  })

  // ── WS2: HTTP and Code steps through the real test-node route ─────────────

  const saveGraph = async (nodes: unknown[], edges: unknown[]) => {
    await prisma.flow.update({
      where: { id: flowId, organizationId: seeded.organizationId },
      data: { graph: { nodes, edges } as Prisma.InputJsonValue },
    })
  }

  const testNode = async (nodeId: string, input?: unknown) => {
    const { POST } = await import('../flows/[id]/test-node/route')
    const response = await POST(jsonReq(`/api/flows/${flowId}/test-node`, 'POST', { nodeId, input }))
    return { status: response.status, body: await response.json() }
  }

  test('an http step with an attached vault credential injects it end-to-end', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://example.com/me', authMode: 'generic', credentialType: 'custom', credentialId } },
      ],
      [{ id: 'e1', source: 't', target: 'h1' }],
    )
    sent.length = 0
    const { status, body } = await testNode('h1', 'go')
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.run.status, 'succeeded')
    assert.equal(sent[0].headers['x-renamed'], 'secret-one', 'the vault credential rode the real execution path')
  })

  test('a JavaScript code step runs through the real route and engine', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'c1', type: 'code', data: { language: 'javascript', mode: 'allItems', code: 'return items.map((n) => n * 2)', input: '{{trigger.input}}' } },
      ],
      [{ id: 'e1', source: 't', target: 'c1' }],
    )
    const { status, body } = await testNode('c1', [1, 2, 3])
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.run.status, 'succeeded')
    assert.deepEqual(body.run.output, [2, 4, 6])
  })

  test('a Python code step runs through the real route and engine', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'c1', type: 'code', data: { language: 'python', mode: 'eachItem', code: 'return _item["n"] + 1', input: '{{trigger.input}}' } },
      ],
      [{ id: 'e1', source: 't', target: 'c1' }],
    )
    const { status, body } = await testNode('c1', [{ n: 1 }, { n: 9 }])
    assert.equal(status, 200, JSON.stringify(body))
    assert.equal(body.run.status, 'succeeded', JSON.stringify(body))
    assert.deepEqual(body.run.output, [2, 10])
  })

  test('print() output rides the test-node response as logs', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'c1', type: 'code', data: { language: 'python', mode: 'allItems', code: 'print("checking", len(_items))\nreturn len(_items)' } },
      ],
      [{ id: 'e1', source: 't', target: 'c1' }],
    )
    const { body } = await testNode('c1', [1, 2, 3])
    assert.equal(body.run.status, 'succeeded', JSON.stringify(body))
    assert.deepEqual(body.run.logs, ['checking 3'], 'captured print lines reach the caller')
  })

  test('a failing code step surfaces the engine error on the run', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'c1', type: 'code', data: { language: 'python', mode: 'allItems', code: 'raise ValueError("bad data")' } },
      ],
      [{ id: 'e1', source: 't', target: 'c1' }],
    )
    const { body } = await testNode('c1', 'go')
    assert.equal(body.run.status, 'failed')
    assert.match(body.run.error ?? '', /ValueError: bad data/)
  })
  // LAST on purpose: this burns the per-user rate-limit window, so any
  // test after it would be throttled by this one rather than by its own
  // behaviour.
  test('/test-node is rate limited — arbitrary code execution must not be unthrottled', async () => {
    await saveGraph(
      [
        { id: 't', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'c1', type: 'code', data: { language: 'javascript', mode: 'allItems', code: 'return 1' } },
      ],
      [{ id: 'e1', source: 't', target: 'c1' }],
    )
    const { POST } = await import('../flows/[id]/test-node/route')
    let limited = 0
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const response = await POST(jsonReq(`/api/flows/${flowId}/test-node`, 'POST', { nodeId: 'c1', input: 'go' }))
      if (response.status === 429) limited += 1
    }
    assert.ok(limited > 0, 'a burst of step tests must eventually be throttled')
  })

}
