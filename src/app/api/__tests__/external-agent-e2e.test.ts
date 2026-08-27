/**
 * An external agent joins the roster and receives work, end to end through
 * the REAL surfaces: POST /api/agents (with an external binding), the request
 * route, the runtime's external branch, the callback route, and the MCP
 * server's ask_agent/get_request. The endpoint is a public https host served
 * by fetch interception (localhost is SSRF-blocked by design).
 *
 * Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.EXECUTION_MODE = 'inline'
  process.env.ALLOW_UNENCRYPTED_SECRETS = '1'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

  const ENDPOINT = 'https://example.com/qa-agent'
  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let agentId: string
  let realFetch: typeof fetch
  let mode: 'sync' | 'async' | 'down' = 'sync'
  const captured: Array<{ headers: Record<string, string>; body: any }> = []

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('timed out')
  }
  const requestById = (id: string) => prisma.agentRequest.findFirst({ where: { id, organizationId } })
  const settled = (id: string) => waitFor(async () => { const r = await requestById(id); return ['completed', 'failed', 'declined'].includes(r?.status) ? r : null })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
    await prisma.user.update({ where: { id: userId }, data: { name: 'Jamie' } })

    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (!url.startsWith(ENDPOINT)) return realFetch(input, init)
      const headers = Object.fromEntries(new Headers(init?.headers as HeadersInit).entries())
      captured.push({ headers, body: JSON.parse(String(init?.body ?? '{}')) })
      if (mode === 'down') return new Response('nope', { status: 503 })
      if (mode === 'async') return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ output: 'External says: Acme is at risk.' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    await seeded?.cleanup?.()
  })

  test('an external agent is created with a vetted endpoint and an encrypted secret', async () => {
    const { POST } = await import('../agents/route')
    const response = await POST(post('/api/agents', {
      title: 'Ext', instructions: 'Answer renewal questions from our own system.', runtime: 'external',
      external: { endpointUrl: ENDPOINT, authType: 'bearer', secret: 's3cret-token', timeoutMinutes: 5 },
    }))
    assert.equal(response.status, 200, await response.clone().text())
    const payload = await response.json()
    agentId = payload.agent.id
    assert.equal(payload.agent.runtime, 'external')
    assert.equal(payload.agent.external.host, 'example.com')
    assert.equal(payload.agent.external.hasSecret, true)
    assert.equal(JSON.stringify(payload).includes('s3cret-token'), false, 'the secret is never echoed')
    const binding = await prisma.externalAgentBinding.findFirst({ where: { agentTaskId: agentId, organizationId } })
    assert.notEqual(binding.authConfig.secretEnc, 's3cret-token', 'ciphertext at rest')
  })

  test('a private-network endpoint is refused before any row exists', async () => {
    const { POST } = await import('../agents/route')
    const before = await prisma.agentTask.count({ where: { organizationId } })
    const response = await POST(post('/api/agents', {
      title: 'Evil', instructions: 'x', runtime: 'external', external: { endpointUrl: 'http://169.254.169.254/latest/meta-data', authType: 'none' },
    }))
    assert.equal(response.status, 400)
    assert.equal(await prisma.agentTask.count({ where: { organizationId } }), before)
  })

  test('an ask is POSTed to the endpoint with auth and a callback, and an inline answer settles it', async () => {
    mode = 'sync'; captured.length = 0
    const { POST } = await import('../agents/[id]/requests/route')
    const payload = await (await POST(post(`/api/agents/${agentId}/requests`, { text: 'look at the Acme renewal' }))).json()
    const request = await settled(payload.requestId)
    assert.equal(request.status, 'completed')
    assert.match(request.result, /External says/)
    assert.equal(captured.length, 1, 'exactly one dispatch')
    const { headers, body } = captured[0]
    assert.equal(headers.authorization, 'Bearer s3cret-token')
    assert.equal(body.protocol, 'sublime-external-agent/1')
    assert.equal(body.request.text, 'look at the Acme renewal')
    assert.equal(body.request.requesterName, 'Jamie')
    assert.equal(body.callbackUrl, `https://app.test/api/agents/${agentId}/external/callback`)
    assert.ok(body.callbackToken?.length > 30)
    const execution = await prisma.agentExecution.findFirst({ where: { id: payload.executionId, organizationId } })
    assert.equal(execution.status, 'completed')
    assert.equal(execution.metadata.externalCallbackHash, null, 'token cleared by the settle')
  })

  test('202 parks the run; the callback settles it once, with the right token only', async () => {
    mode = 'async'; captured.length = 0
    const { POST } = await import('../agents/[id]/requests/route')
    const payload = await (await POST(post(`/api/agents/${agentId}/requests`, { text: 'deep dive on Acme' }))).json()
    const parked = await waitFor(async () => {
      const row = await prisma.agentExecution.findFirst({ where: { id: payload.executionId, organizationId } })
      return row?.status === 'waiting_for_external' ? row : null
    })
    assert.ok(parked)
    assert.equal((await requestById(payload.requestId)).status, 'running', 'the requester sees Working…, not Needs you')
    const token = captured[0].body.callbackToken as string

    const { POST: callback } = await import('../agents/[id]/external/callback/route')
    const wrong = await callback(post(`/api/agents/${agentId}/external/callback`, { runId: payload.executionId, output: 'forged' }, { 'x-callback-token': 'nope' }))
    assert.equal(wrong.status, 401)
    assert.equal((await prisma.agentExecution.findFirst({ where: { id: payload.executionId, organizationId } })).status, 'waiting_for_external')

    const ok = await callback(post(`/api/agents/${agentId}/external/callback`, { runId: payload.executionId, output: 'Acme: champion left in June; renewal at risk.' }, { 'x-callback-token': token }))
    assert.equal(ok.status, 200, await ok.clone().text())
    const done = await settled(payload.requestId)
    assert.equal(done.status, 'completed')
    assert.match(done.result, /champion left/)

    // Single-use: the same token again is refused, and the answer stands.
    const replay = await callback(post(`/api/agents/${agentId}/external/callback`, { runId: payload.executionId, output: 'overwritten' }, { 'x-callback-token': token }))
    assert.equal(replay.status, 401)
    assert.match((await requestById(payload.requestId)).result, /champion left/)
  })

  test('an endpoint that is down fails the run with a reason the requester can read', async () => {
    mode = 'down'
    const { POST } = await import('../agents/[id]/requests/route')
    const payload = await (await POST(post(`/api/agents/${agentId}/requests`, { text: 'anything' }))).json()
    const request = await settled(payload.requestId)
    assert.equal(request.status, 'failed')
    assert.match(request.error, /503/)
  })

  test('a parked run past its deadline is failed by the sweep, and its request with it', async () => {
    mode = 'async'; captured.length = 0
    const { POST } = await import('../agents/[id]/requests/route')
    const payload = await (await POST(post(`/api/agents/${agentId}/requests`, { text: 'slow one' }))).json()
    await waitFor(async () => (await prisma.agentExecution.findFirst({ where: { id: payload.executionId, organizationId } }))?.status === 'waiting_for_external' ? true : null)
    const { reapExternalTimeouts } = await import('@/lib/agents/external-run')
    assert.equal(await reapExternalTimeouts(new Date()), 0, 'not yet due')
    assert.equal(await reapExternalTimeouts(new Date(Date.now() + 6 * 60_000)), 1, 'due after the 5-minute deadline')
    const request = await settled(payload.requestId)
    assert.equal(request.status, 'failed')
    assert.match(request.error, /never called back/)
  })

  test('an MCP client with agents:execute can ask a Sublime agent and read the answer', async () => {
    mode = 'sync'
    const { generateApiKey } = await import('@/lib/api-keys/keys')
    const generated = generateApiKey()
    await prisma.apiKey.create({ data: { organizationId, createdById: userId, name: 'ext', prefix: generated.prefix, hash: generated.hash, scopes: ['agents:execute', 'agents:read'] } })
    const { POST } = await import('../mcp/route')
    const rpc = (method: string, params: unknown, id = 1) =>
      (POST as unknown as (request: NextRequest) => Promise<Response>)(
        post('/api/mcp', { jsonrpc: '2.0', id, method, params }, { authorization: `Bearer ${generated.plaintext}` }),
      )
    // MCP tool results arrive as JSON inside a text content block.
    const resultOf = (envelope: any) => JSON.parse(envelope?.result?.content?.[0]?.text ?? '{}')

    const listed = await (await rpc('tools/list', {})).json()
    const names = JSON.stringify(listed)
    assert.match(names, /ask_agent/); assert.match(names, /get_request/)

    const asked = resultOf(await (await rpc('tools/call', { name: 'ask_agent', arguments: { agent: 'Ext', text: 'status of Acme?' } }, 2)).json())
    const requestId = asked.requestId as string | undefined
    assert.ok(requestId, `no requestId in ${JSON.stringify(asked).slice(0, 300)}`)
    assert.equal(asked.agent, 'Ext')
    await settled(requestId!)
    const read = resultOf(await (await rpc('tools/call', { name: 'get_request', arguments: { requestId } }, 3)).json())
    assert.equal(read.status, 'completed')
    assert.match(read.result, /External says/)
    // Provenance: the key's creator is the requester; origin says it came over the API.
    const row = await requestById(requestId!)
    assert.equal(row.origin, 'api')
    assert.equal(row.requestedByUserId, userId)
  })
}
