import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { startFakeLlm } from './fake-llm-sse'

/**
 * Needs a real database (seedTestOrg + prisma). Gated so `npm test` stays
 * green on a machine without Postgres — the same convention every other
 * DB-backed suite here follows. Without it these ran unconditionally and
 * `npm test` was red by default for anyone with no TEST_DATABASE_URL.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: Awaited<ReturnType<Awaited<typeof import('@/lib/server/__tests__/test-auth')>['seedTestOrg']>>
  let fake: Awaited<ReturnType<typeof startFakeLlm>>
  let agentId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)

    const agent = await prisma.agentTask.create({
      data: {
        description: 'pipeline auditor', objective: 'audit', organizationId: seeded.auth.organizationId,
        userId: seeded.auth.dbUser.id, metadata: { title: 'Pipeline Auditor' },
      },
    })
    agentId = agent.id
    await prisma.agentExecution.create({
      data: {
        agentTaskId: agentId, organizationId: seeded.auth.organizationId,
        agentType: 'CUSTOM', input: {}, trigger: { type: 'manual' }, userId: seeded.auth.dbUser.id,
        status: 'failed', startedAt: new Date(), error: 'auth expired', metadata: { error: 'auth expired' },
      },
    })

    // Turn 1: model reads runs. Turn 2: model answers in prose.
    fake = await startFakeLlm([
      { toolUse: { id: 'tu1', name: 'list_runs', input: { status: 'failed', limit: 5, before: null } } },
      { text: 'The last run failed because Salesforce auth expired.' },
    ])
    process.env.QWEN_API_KEY = 'fake'
    process.env.QWEN_BASE_URL = fake.url
    process.env.AGENT_MODEL = 'qwen-3.7'
    process.env.SUMMARY_MODEL = 'qwen-3.7'
    delete process.env.ANTHROPIC_API_KEY
  })

  after(async () => {
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    delete process.env.AGENT_MODEL
    delete process.env.SUMMARY_MODEL
    await fake.close()
    await seeded.cleanup()
  })

  const post = (accept: string, body: unknown) =>
    new NextRequest(new URL(`http://test/api/agents/${agentId}/chat`), {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept },
    } as never)

  function parseSse(bodyText: string): Array<Record<string, unknown>> {
    return bodyText.split('\n\n').filter(Boolean)
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
  }

  test('streaming POST emits tool activity then a result event, and persists the thread', async () => {
    const { POST } = await import('../agents/[id]/chat/route')
    const response = await POST(post('text/event-stream', { message: 'why did the last run fail?' }))
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const events = parseSse(await new Response(response.body).text())

    const types = events.map((event) => event.type)
    assert.ok(types.includes('tool'), `expected a tool event, got ${JSON.stringify(types)}`)
    assert.equal(types[types.length - 1], 'result')

    const result = events[events.length - 1] as unknown as { success: boolean; sessionId: string; messages: Array<{ role: string; content: string }> }
    assert.equal(result.success, true)
    assert.equal(result.messages.length, 2)
    assert.match(result.messages[1].content, /auth expired/i)

    // Thread persisted exactly as the non-streaming path would persist it.
    const rows = await prisma.agentChatMessage.findMany({
      where: { organizationId: seeded.auth.organizationId, agentTaskId: agentId, sessionId: result.sessionId },
    })
    assert.equal(rows.length, 2)
  })

  test('JSON fallback returns the legacy body shape', async () => {
    const { POST } = await import('../agents/[id]/chat/route')
    const response = await POST(post('application/json', { message: 'and again?' }))
    assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
    const body = (await response.json()) as { success: boolean; sessionId: string; messages: unknown[] }
    assert.equal(body.success, true)
    assert.equal(body.messages.length, 2)
  })

} else {
  test('agent-copilot-loop-e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}