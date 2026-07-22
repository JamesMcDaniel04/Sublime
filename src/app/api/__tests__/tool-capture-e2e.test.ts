/**
 * End-to-end QA drive for the phase 1 tool_call CAPTURE SEAMS — the two
 * places that accumulate touched providers during real execution and flush
 * them as deduped ledger events:
 *
 *   1. Flow executor seam: a REAL flow run whose tool step calls an MCP
 *      connection through the real plane resolver, SSRF guard, and MCP
 *      JSON-RPC client — only the network hop itself is answered by a local
 *      fetch intercept (the serverUrl is a public hostname, so the real DNS
 *      SSRF check runs and passes).
 *   2. Agent loop seam: a REAL agent run driven end-to-end by a local
 *      scripted server speaking the Anthropic Messages wire (the Qwen
 *      endpoint path), whose script makes the agent call a flow tool TWICE —
 *      proving both the capture and the one-event-per-(execution, provider)
 *      dedupe.
 *
 * Real Postgres (TEST_DATABASE_URL), real route handlers, real executors.
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
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
  let llmRequests = 0
  let realFetch: typeof fetch

  const MCP_URL = 'https://example.com/qa-mcp'

  /** Minimal MCP server behind a fetch intercept: initialize / tools/list / tools/call. */
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
      return reply({ content: [{ type: 'text', text: 'echoed' }] })
    }
    return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } })
  }

  const childGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
  }

  /** Anthropic Messages SSE for one assistant message. */
  const sseFor = (blocks: Array<Record<string, unknown>>, stopReason: string): string => {
    const events: Array<[string, Record<string, unknown>]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ]
    blocks.forEach((block, i) => {
      if (block.type === 'tool_use') {
        events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } }])
      } else {
        events.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }])
        events.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } }])
      }
      events.push(['content_block_stop', { type: 'content_block_stop', index: i }])
    })
    events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }])
    events.push(['message_stop', { type: 'message_stop' }])
    return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  }

  /**
   * The script: while the transcript holds fewer than two tool_results, keep
   * calling the first available flow tool; then finish with text. Non-agent
   * surfaces (headline, reflection) get a plain text reply.
   */
  const scriptTurn = (body: any): { blocks: Array<Record<string, unknown>>; stopReason: string } => {
    const tools: Array<{ name: string }> = body.tools ?? []
    const flowTool = tools.find((t) => t.name.startsWith('flow_'))
    const toolResults = (body.messages ?? []).flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'tool_result') : [],
    )
    if (flowTool && toolResults.length < 2) {
      return { blocks: [{ type: 'tool_use', id: `qa-call-${toolResults.length + 1}`, name: flowTool.name, input: {} }], stopReason: 'tool_use' }
    }
    return { blocks: [{ type: 'text', text: 'QA run complete.' }], stopReason: 'end_turn' }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId

    // The agent-callable child flow both seams execute.
    await prisma.flow.create({
      data: {
        name: 'QA Echo Child', organizationId, userId, status: 'ACTIVE', visibility: 'shared',
        trigger: { type: 'manual' }, graph: childGraph, publishedGraph: childGraph,
        metadata: { agentCallable: true },
      },
    })

    // Scripted Anthropic-wire endpoint (the Qwen path reuses the Anthropic SDK).
    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        llmRequests += 1
        const body = JSON.parse(raw || '{}')
        const { blocks, stopReason } = scriptTurn(body)
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sseFor(blocks, stopReason))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa',
            content: blocks.map((b) => (b.type === 'tool_use' ? b : { type: 'text', text: b.text })),
            stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 },
          }))
        }
      })
    })
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve))
    const port = (llmServer.address() as { port: number }).port
    process.env.QWEN_API_KEY = 'qa-key'
    process.env.QWEN_BASE_URL = `http://127.0.0.1:${port}`

    // The MCP connection the flow-seam test calls; network answered locally.
    mcpConnectionId = (await prisma.mcpConnection.create({
      data: { organizationId, userId, name: 'qatools', serverUrl: MCP_URL, authType: 'none', isActive: true },
    })).id
    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.startsWith(MCP_URL)) return mcpResponder(init ?? (typeof input === 'object' ? input : undefined))
      return realFetch(input, init)
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    await new Promise<void>((resolve) => llmServer.close(() => resolve()))
    if (seeded) await seeded.cleanup()
  })

  test('flow seam: a real run’s MCP tool step flushes a deduped tool_call event', async () => {
    const parentGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'tool1', type: 'tool', data: { connectionId: mcpConnectionId, toolName: 'qa_echo', args: '{}' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'tool1' }],
    }
    const parent = await prisma.flow.create({
      data: {
        name: 'QA Parent', organizationId, userId, status: 'ACTIVE', visibility: 'private',
        trigger: { type: 'manual' }, graph: parentGraph, publishedGraph: parentGraph,
      },
    })
    const { dispatchFlowExecution } = await import('@/features/flows/execute-flow')
    const result = await dispatchFlowExecution({
      flowId: parent.id, organizationId, userId, input: {}, usePublished: true, trigger: { type: 'manual' },
    } as never)
    assert.ok(!('queued' in result), 'expected inline execution')
    assert.equal((result as any).status, 'succeeded', `run failed: ${JSON.stringify(result)}`)

    const runId = (result as any).flowRunId
    const events = await prisma.userEvent.findMany({
      where: { organizationId, userId, kind: 'tool_call', context: { path: ['executionId'], equals: runId } },
    })
    assert.equal(events.length, 1, 'expected exactly one tool_call event for the run segment')
    assert.equal(events[0].resourceId, 'qatools') // mcpConnectionSlug of the connection name
    assert.deepEqual(events[0].context.toolNames, ['qa_echo'])
  })

  test('agent seam: a real LLM-driven run captures + dedupes across two tool calls', async () => {
    const post = (path: string, body: unknown) =>
      new NextRequest(new URL(`http://test${path}`), {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
      } as never)

    const createRes = await (await import('../agents/route')).POST(
      // allowFlows opts this agent into the flow tool-plane; empty flowIds =
      // any agent-callable flow (the QA Echo Child above).
      post('/api/agents', { title: 'QA Capture Agent', instructions: 'Run the QA Echo Child flow, then report done.', allowFlows: true }),
    )
    assert.equal(createRes.status, 200)
    const agentId = (await createRes.json()).agent.id

    const execRes = await (await import('../agents/[id]/execute/route')).POST(
      post(`/api/agents/${agentId}/execute`, { input: 'Run the child flow twice.' }),
    )
    assert.equal(execRes.status, 200, 'inline agent run failed')
    const executionId = (await execRes.json()).executionId
    assert.ok(llmRequests >= 3, `scripted LLM barely used (${llmRequests} requests)`)

    // Both scripted tool calls succeeded as real workflow steps...
    const steps = await prisma.workflowStep.findMany({
      where: { executionId, status: 'succeeded', node: { startsWith: 'flow.' } },
    })
    assert.equal(steps.length, 2, 'expected two successful flow tool steps')

    // ...but the capture seam flushed exactly ONE deduped tool_call event.
    const events = await prisma.userEvent.findMany({
      where: { organizationId, userId, kind: 'tool_call', context: { path: ['executionId'], equals: executionId } },
    })
    assert.equal(events.length, 1, `dedupe broken: ${events.length} events for one (execution, provider)`)
    assert.equal(events[0].resourceId, 'flow')
    assert.equal(events[0].context.provider, 'flow')
    assert.equal((events[0].context.toolNames as string[]).length, 1, 'tool name not deduped')
  })
} else {
  test('tool-capture e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
