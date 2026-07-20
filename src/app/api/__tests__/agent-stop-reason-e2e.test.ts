/**
 * A real agent run, driven end-to-end through the actual API routes against a
 * scripted server speaking the Anthropic Messages wire (the Qwen endpoint
 * path, same trick as tool-capture-e2e.test.ts) — proving that a non-`end_turn`
 * stop_reason (refusal / max_tokens) is surfaced as a capped run instead of
 * being silently dressed up as a normal completion.
 *
 * Real Postgres (TEST_DATABASE_URL), real route handlers, real execute-agent
 * loop. Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke
 * and tool-capture-e2e).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let llmServer: http.Server
  let nextStopReason = 'refusal'

  /** Single-event Anthropic Messages SSE: no content blocks, just the stop_reason. */
  const sseFor = (stopReason: string): string => {
    const events: Array<[string, Record<string, unknown>]> = [
      ['message_start', { type: 'message_start', message: { id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        void raw
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sseFor(nextStopReason))
      })
    })
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve))
    const port = (llmServer.address() as { port: number }).port
    process.env.QWEN_API_KEY = 'qa-key'
    process.env.QWEN_BASE_URL = `http://127.0.0.1:${port}`
  })

  after(async () => {
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    await new Promise<void>((resolve) => llmServer.close(() => resolve()))
    if (seeded) await seeded.cleanup()
  })

  beforeEach(() => {
    nextStopReason = 'refusal'
  })

  const post = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    } as never)

  const createAndRun = async (input: string) => {
    const createRes = await (await import('../agents/route')).POST(
      post('/api/agents', { title: 'QA Stop-Reason Agent', instructions: 'Answer the user directly, no tools needed.' }),
    )
    assert.equal(createRes.status, 200)
    const agentId = (await createRes.json()).agent.id

    const execRes = await (await import('../agents/[id]/execute/route')).POST(
      post(`/api/agents/${agentId}/execute`, { input }),
    )
    assert.equal(execRes.status, 200, 'inline agent run failed')
    return (await execRes.json()).executionId as string
  }

  test('a refusal stop_reason caps the run instead of completing it cleanly', async () => {
    nextStopReason = 'refusal'
    const executionId = await createAndRun('Do something the model will decline.')

    const execution = await prisma.agentExecution.findUnique({
      where: { id: executionId, organizationId: seeded.organizationId },
    })
    assert.equal(execution.status, 'completed', 'a capped run still finalizes as completed, not failed')
    assert.equal((execution.output as any)?.capped, 'model_refusal')
    assert.match((execution.output as any)?.summary ?? '', /declined/i)
  })

  test('a max_tokens stop_reason caps the run as incomplete instead of completing it cleanly', async () => {
    nextStopReason = 'max_tokens'
    const executionId = await createAndRun('Write something long enough to get cut off.')

    const execution = await prisma.agentExecution.findUnique({
      where: { id: executionId, organizationId: seeded.organizationId },
    })
    assert.equal(execution.status, 'completed')
    assert.equal((execution.output as any)?.capped, 'model_incomplete')
  })
} else {
  test('agent stop-reason e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
