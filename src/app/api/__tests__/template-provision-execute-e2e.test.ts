/**
 * Catalogue seed → /api/templates/provision → activate → execute, end to end.
 *
 * Before this test, provisioning was only ever tested to the point of graph
 * construction — no test executed a provisioned flow. This drives the seed
 * `sales-new-lead-to-sf-opportunity` through the REAL provision route
 * (pre-flight 409, agent materialization, template: binding, activation) and
 * then the REAL execute route:
 *   - agent node     → materialized AgentTask, run by the real agent loop
 *                      against a local Anthropic-wire stub (QWEN_BASE_URL).
 *   - template:salesforce tool → bound at provision to the workspace's Nango
 *                      salesforce connection; executes through the real Nango
 *                      SDK against a local stub via NANGO_HOST.
 *   - native:slack tool → real SlackToolClient against an intercepted
 *                      https://slack.com/api/chat.postMessage.
 *
 * Also pins the template: pseudo-plane guard: an UNBOUND placeholder reaching
 * the executor fails with an actionable message, not "connection no longer
 * exists".
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // Secret writes refuse to run keyless outside test/opt-in environments.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key-0123456789abcdef01'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let llmServer: http.Server
  let nangoServer: http.Server
  let realFetch: typeof fetch
  const nangoCalls: Array<{ url: string; body: unknown }> = []
  const slackCalls: Array<{ url: string; body: unknown }> = []

  const post = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T | null> => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId

    // Anthropic-wire stub: the materialized agent's real run loop terminates
    // on the first end_turn text reply (a JSON body so the seed's templated
    // downstream args resolve when the output is parsed).
    const agentReply = JSON.stringify({ opportunityName: 'QA Opp', amount: '1000', stage: 'Prospecting', rationale: 'QA fit.' })
    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const message = {
          id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa',
          content: [{ type: 'text', text: agentReply }],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end([
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: agentReply } })}\n\n`,
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

    // Local Nango API stub (real @nangohq/node axios transport via NANGO_HOST).
    nangoServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        nangoCalls.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: 'sf_qa_1' }))
      })
    })
    await new Promise<void>((resolve) => nangoServer.listen(0, '127.0.0.1', resolve))
    process.env.NANGO_SECRET_KEY = 'qa-nango'
    process.env.NANGO_HOST = `http://127.0.0.1:${(nangoServer.address() as { port: number }).port}`

    // Native Slack workspace connection for the notify step.
    const { encryptSecretJson } = await import('@/lib/slack/connections')
    await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId, userId, teamId: 'T0QA111', teamName: 'QA', botUserId: 'U0QABOT',
        botToken: encryptSecretJson('xoxb-qa'), signingSecret: encryptSecretJson('qa-signing'),
      },
    })

    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.startsWith('https://slack.com/api/')) {
        slackCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(JSON.stringify({ ok: true, channel: 'C0QA', ts: '1754000000.000200' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
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
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId } })
      await seeded.cleanup()
    }
  })

  const provision = async (body: Record<string, unknown>) =>
    (await import('../templates/provision/route')).POST(post('/api/templates/provision', body))

  test('pre-flight: provisioning 409s naming the missing provider, creating nothing', async () => {
    const res = await provision({ seedKey: 'sales-new-lead-to-sf-opportunity', targetKind: 'flow' })
    assert.equal(res.status, 409, `expected pre-flight rejection: ${await res.clone().text()}`)
    const body = await res.json()
    assert.equal(body.code, 'MISSING_INTEGRATIONS')
    assert.ok(JSON.stringify(body).includes('salesforce'), 'names the missing provider')
    const flows = await prisma.flow.findMany({ where: { organizationId } })
    assert.equal(flows.length, 0, 'nothing was created')
  })

  test('provision (activate) then execute: agent + bound template:salesforce + native:slack all succeed', async () => {
    // Connect Salesforce (Nango mirror row) — pre-flight now passes.
    await prisma.nangoConnection.create({
      data: { organizationId, userId, connectionId: 'qa-sf-conn', providerConfigKey: 'salesforce', provider: 'salesforce', status: 'connected' },
    })

    const res = await provision({ seedKey: 'sales-new-lead-to-sf-opportunity', targetKind: 'flow', activate: true })
    assert.equal(res.status, 200, `provision failed: ${await res.clone().text()}`)
    const body = await res.json()
    assert.equal(body.kind, 'flow')
    assert.equal(body.activated, true, `activation failed: ${JSON.stringify(body)}`)
    const flowId = body.flowId as string

    const flow = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
    assert.equal(flow.status, 'ACTIVE')
    assert.ok(flow.publishedGraph, 'published')
    // template:salesforce was bound to the workspace's nango connection.
    const boundNode = (flow.graph as any).nodes.find((n: any) => n.id === 'opp')
    assert.equal(boundNode.data.connectionId, 'nango:salesforce')
    const bindings = (flow.metadata as any).resolvedConnections
    assert.ok(Array.isArray(bindings) && bindings.some((b: any) => b.provider === 'salesforce'), 'binding recorded in metadata')
    // The agent ref was materialized into a real, ACTIVE AgentTask.
    const agentNode = (flow.graph as any).nodes.find((n: any) => n.id === 'qualify')
    const agentTask = await prisma.agentTask.findFirst({ where: { id: agentNode.data.agentId, organizationId } })
    assert.equal(agentTask?.status, 'ACTIVE', 'materialized agent exists and is active')

    nangoCalls.length = 0
    slackCalls.length = 0
    const execRes = await (await import('../flows/[id]/execute/route')).POST(
      post(`/api/flows/${flowId}/execute`, { input: { prompt: 'Lead: Ada Lovelace, Analytical Engines Ltd, budget 1000' } }),
    )
    assert.equal(execRes.status, 200, `execute failed: ${await execRes.clone().text()}`)
    const runId = (await execRes.json()).run.id

    const run = await waitFor(async () => {
      const row = await prisma.flowRun.findFirst({ where: { id: runId, organizationId } })
      return row && ['succeeded', 'failed'].includes(row.status) ? row : null
    })
    assert.ok(run, 'run reached a terminal status')
    assert.equal(run.status, 'succeeded', `run failed: ${JSON.stringify(run?.error ?? run)}`)

    const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: runId, run: { organizationId } } })
    const byNode = (id: string) => steps.find((s: any) => s.nodeId === id)
    assert.equal(byNode('qualify')?.status, 'succeeded', 'materialized agent step')
    assert.equal(byNode('opp')?.status, 'succeeded', 'bound salesforce step')
    assert.equal(byNode('notify')?.status, 'succeeded', 'native slack step')

    // The Salesforce write went through the Nango proxy; the Slack post hit
    // the real Slack API surface.
    assert.ok(nangoCalls.length >= 1, 'salesforce create reached the Nango stub')
    const slackPost = slackCalls.find((c) => c.url.includes('chat.postMessage'))
    assert.ok(slackPost, 'slack notify reached chat.postMessage')
    assert.match(JSON.stringify(slackPost.body), /QA Opp/, 'templated agent output reached the Slack message')
  })

  test('an unbound template: placeholder fails execution with an actionable message', async () => {
    const { resolveFlowToolExecutor } = await import('@/features/agents/tool-planes')
    await assert.rejects(
      () => resolveFlowToolExecutor({ organizationId, userId, plane: 'mcp', ref: 'template:salesforce', toolName: 'x' } as never),
      /template placeholder .* never bound .* Re-provision/i,
    )
  })
} else {
  test('template provision-execute e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
