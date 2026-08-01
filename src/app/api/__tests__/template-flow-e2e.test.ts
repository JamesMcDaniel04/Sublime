/**
 * Template → construct → customize → publish → run, end to end, through the
 * REAL surfaces a user hits: POST /api/flows with a starter template's graph
 * (exactly what the template page sends), PUT /api/flows for the editor
 * customization, the publish route, and the execute route — against the real
 * interpreter and QA Postgres.
 *
 * Node-type parity exercised in ONE flow derived from `site-monitor-slack`
 * (the only shipped template with an http node):
 *   - http node        → real performHttpRequest; SSRF guard live-resolves the
 *                        host, so the check URL is a public https host whose
 *                        response is answered by a fetch intercept.
 *   - condition branch → 503 forces the unhealthy path.
 *   - integration node → nango:slack, executed through the real Nango SDK
 *                        (axios) pointed at a local stub via NANGO_HOST.
 *   - inline agent     → real model-runner pointed at a local Anthropic-wire
 *                        stub via QWEN_BASE_URL (the sanctioned local seam).
 *   - MCP tool node    → real McpClient JSON-RPC against a fetch-intercepted
 *                        https URL (localhost is SSRF-blocked by design).
 *
 * MCP nodes CANNOT ship in templates (connection ids are raw DB row ids —
 * starter-templates.ts:8 documents this), so the MCP step is added the way a
 * real user adds one: an editor save (PUT) after construction.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let mcpConnectionId: string
  let llmServer: http.Server
  let nangoServer: http.Server
  let realFetch: typeof fetch

  const SITE_URL = 'https://example.com/qa-site'
  const MCP_URL = 'https://example.com/qa-mcp'
  let siteStatus = 503
  const nangoCalls: Array<{ url: string; body: unknown }> = []

  const mcpResponder = async (init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    if (body.method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'qa-mcp', version: '1.0.0' } })
    }
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: 'qa_echo', description: 'Echo back the input.', inputSchema: { type: 'object', properties: {} } }] })
    }
    if (body.method === 'tools/call') {
      return reply({ content: [{ type: 'text', text: `echoed:${JSON.stringify(body.params?.arguments ?? {})}` }] })
    }
    return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } })
  }

  const post = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)
  const put = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 20_000): Promise<T | null> => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const terminalRun = (flowRunId: string) =>
    waitFor(async () => {
      const run = await prisma.flowRun.findFirst({ where: { id: flowRunId, organizationId } })
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null
    })
  const stepsFor = (flowRunId: string) =>
    prisma.flowRunStep.findMany({ where: { flowRunId, run: { organizationId } }, orderBy: { startedAt: 'asc' } })

  /** Construct from the starter template through the real create route —
   *  byte-for-byte what the template page POSTs. */
  const constructFromTemplate = async () => {
    const { STARTER_TEMPLATES } = await import('@/lib/flows/starter-templates')
    const template = STARTER_TEMPLATES.find((t: any) => t.key === 'site-monitor-slack')
    assert.ok(template, 'site-monitor-slack starter template exists')
    const res = await (await import('../flows/route')).POST(
      post('/api/flows', { name: template.name, description: template.description, trigger: template.trigger, graph: template.graph }),
    )
    assert.equal(res.status, 200, `flow create failed: ${await res.clone().text()}`)
    const body = await res.json()
    return { flowId: body.flow.id as string, graph: template.graph, missingIntegrations: body.missingIntegrations as Array<{ nodeId: string; connectionId: string }> | undefined }
  }

  const publish = async (flowId: string) => {
    const res = await (await import('../flows/[id]/publish/route')).POST(post(`/api/flows/${flowId}/publish`, {}))
    assert.equal(res.status, 200, `publish failed: ${await res.clone().text()}`)
  }

  const execute = async (flowId: string, input: Record<string, unknown>) => {
    const res = await (await import('../flows/[id]/execute/route')).POST(post(`/api/flows/${flowId}/execute`, { input }))
    assert.equal(res.status, 200, `execute failed: ${await res.clone().text()}`)
    const body = await res.json()
    return body.run.id ?? body.run.flowRunId ?? body.run
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId

    // Local Anthropic-wire stub for inline agent nodes (QWEN_BASE_URL is the
    // sanctioned local-LLM seam; the Qwen path reuses the Anthropic SDK).
    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const message = {
          id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa',
          content: [{ type: 'text', text: 'Summary: the site is degraded (HTTP 503); Slack was alerted.' }],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end([
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          ].join(''))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(message))
        }
      })
    })
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve))
    process.env.QWEN_API_KEY = 'qa-key'
    process.env.QWEN_BASE_URL = `http://127.0.0.1:${(llmServer.address() as { port: number }).port}`

    // Local Nango API stub — the real @nangohq/node SDK (axios) talks to it
    // via NANGO_HOST, so the integration node runs its true transport.
    nangoServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        nangoCalls.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, channel: 'C0QA', ts: '1754000000.000100' }))
      })
    })
    await new Promise<void>((resolve) => nangoServer.listen(0, '127.0.0.1', resolve))

    // A connected Slack account (Nango mirror row) for the delivery plane.
    await prisma.nangoConnection.create({
      data: { organizationId, userId, connectionId: 'qa-slack-conn', providerConfigKey: 'slack', provider: 'slack', status: 'connected' },
    })
    // The MCP server the user-added node calls; network answered by the fetch
    // intercept (https + public host so the live SSRF guard passes).
    mcpConnectionId = (await prisma.mcpConnection.create({
      data: { organizationId, userId, name: 'qatools', serverUrl: MCP_URL, authType: 'none', isActive: true },
    })).id

    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.startsWith(SITE_URL)) return new Response('service unavailable', { status: siteStatus })
      if (url.startsWith(MCP_URL)) return mcpResponder(init ?? (typeof input === 'object' ? input : undefined))
      return realFetch(input, init)
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    delete process.env.NANGO_SECRET_KEY
    delete process.env.NANGO_HOST
    await new Promise<void>((resolve) => llmServer.close(() => resolve()))
    await new Promise<void>((resolve) => nangoServer.close(() => resolve()))
    if (seeded) await seeded.cleanup()
  })

  test('out of the box: construction succeeds, and publish FAILS CLOSED naming the unavailable Slack connection', async () => {
    delete process.env.NANGO_SECRET_KEY
    delete process.env.NANGO_HOST
    const { flowId, missingIntegrations } = await constructFromTemplate()

    // Construction-time warning: the user learns about the missing Slack
    // connection when the draft is created, not first at publish.
    assert.ok(missingIntegrations?.some((m) => m.nodeId === 'alert' && m.connectionId === 'nango:slack'),
      `expected the alert node's nango:slack in missingIntegrations, got ${JSON.stringify(missingIntegrations)}`)

    // Construction is permissive (a draft may reference integrations you have
    // not connected yet); PUBLISH is the gate. This is stricter than a
    // runtime-degradation model — a broken run can never exist.
    const res = await (await import('../flows/[id]/publish/route')).POST(post(`/api/flows/${flowId}/publish`, {}))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.code, 'FLOW_VALIDATION_ERROR')
    assert.match(String(body.error), /Alert Slack uses a connection that is not available/)

    const runs = await prisma.flowRun.findMany({ where: { flowId, organizationId } })
    assert.equal(runs.length, 0, 'no run ever existed for the unpublishable draft')
  })

  test('customized template runs end to end: http 503 → condition → Slack alert → inline agent summary → MCP echo, all succeeded', async () => {
    process.env.NANGO_SECRET_KEY = 'qa-nango'
    process.env.NANGO_HOST = `http://127.0.0.1:${(nangoServer.address() as { port: number }).port}`

    const { flowId, graph } = await constructFromTemplate()

    // The editor customization a real user makes: after the Slack alert,
    // summarize with an inline agent, then call an MCP tool.
    const customized = {
      nodes: [
        ...graph.nodes,
        { id: 'summarize', type: 'agent', data: { label: 'Summarize incident', agentId: '', prompt: 'Summarize the site check result for an operator.', input: 'Site {{input.url}} returned HTTP {{step.check.output.status}}.' } },
        { id: 'echo', type: 'tool', data: { label: 'Echo to MCP', connectionId: mcpConnectionId, toolName: 'qa_echo', args: '{"status":"{{step.check.output.status}}"}' } },
      ],
      edges: [
        ...graph.edges,
        { id: 'e6', source: 'alert', target: 'summarize' },
        { id: 'e7', source: 'summarize', target: 'echo' },
      ],
    }
    const saveRes = await (await import('../flows/route')).PUT(put('/api/flows', { id: flowId, graph: customized }))
    assert.equal(saveRes.status, 200, `editor save failed: ${await saveRes.clone().text()}`)
    await publish(flowId)

    siteStatus = 503
    nangoCalls.length = 0
    const runId = await execute(flowId, { url: SITE_URL, channel: '#alerts' })
    const run = await terminalRun(runId)
    assert.ok(run, 'run reached a terminal status')
    assert.equal(run.status, 'succeeded', `run failed: ${JSON.stringify(run?.error ?? run)}`)

    const steps = await stepsFor(runId)
    const byNode = (id: string) => steps.find((s: any) => s.nodeId === id)
    assert.equal(byNode('check')?.status, 'succeeded', 'http node')
    assert.equal(byNode('alert')?.status, 'succeeded', 'integration (nango:slack) node')
    assert.equal(byNode('summarize')?.status, 'succeeded', 'inline agent node')
    assert.equal(byNode('echo')?.status, 'succeeded', 'MCP tool node')

    // The Slack message really left through the Nango proxy with the templated args.
    const slackCall = nangoCalls.find((c) => c.url.includes('chat.postMessage'))
    assert.ok(slackCall, `expected a Nango proxy call, saw: ${JSON.stringify(nangoCalls.map((c) => c.url))}`)
    assert.match(JSON.stringify(slackCall.body), /#alerts/)
    assert.match(JSON.stringify(slackCall.body), /503/)

    // Agent summary came from the local model stub; MCP echo carried the templated status.
    assert.match(JSON.stringify(byNode('summarize')?.output ?? ''), /degraded/)
    assert.match(JSON.stringify(byNode('echo')?.output ?? ''), /echoed/)
  })

  test('healthy branch: a 200 response stops the flow with no alert and no Slack call', async () => {
    process.env.NANGO_SECRET_KEY = 'qa-nango'
    process.env.NANGO_HOST = `http://127.0.0.1:${(nangoServer.address() as { port: number }).port}`
    const { flowId } = await constructFromTemplate()
    await publish(flowId)

    siteStatus = 200
    nangoCalls.length = 0
    const runId = await execute(flowId, { url: SITE_URL, channel: '#alerts' })
    const run = await terminalRun(runId)
    assert.equal(run?.status, 'succeeded')
    const steps = await stepsFor(runId)
    assert.equal(steps.find((s: any) => s.nodeId === 'alert'), undefined, 'alert never ran')
    // Publish-time tool-catalog checks may ping the Nango API; what must not
    // happen is a MESSAGE leaving — filter to the Slack post endpoint.
    assert.equal(nangoCalls.filter((c) => c.url.includes('chat.postMessage')).length, 0, 'no Slack message left the building')
  })
} else {
  test('template flow e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
