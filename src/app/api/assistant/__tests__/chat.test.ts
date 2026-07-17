import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let sessionId: string
  let messageId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const session = await prisma.assistantChatSession.create({
      data: { organizationId: seeded.organizationId, userId: seeded.userId, title: 'Seeded chat' },
    })
    sessionId = session.id
    const message = await prisma.assistantChatMessage.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        sessionId,
        role: 'assistant',
        content: 'Created the agent.',
        metadata: { createdAgent: { id: 'a1', title: 'T', icon: '🤖', description: '' } },
      },
    })
    messageId = message.id
  })

  after(async () => {
    // Guard: if before() threw (seed failure), seeded is undefined — don't
    // throw a secondary error over the real one.
    if (seeded) await seeded.cleanup()
  })

  test('GET /api/assistant/chat returns the latest session messages', async () => {
    const { GET } = await import('../chat/route')
    const res = await GET(new NextRequest(new URL('http://test/api/assistant/chat')))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.sessionId, sessionId)
    assert.equal(data.messages.length, 1)
    assert.equal(data.messages[0].createdAgent.id, 'a1')
  })

  test('GET /api/assistant/chat/sessions lists only sessions with messages', async () => {
    await prisma.assistantChatSession.create({
      data: { organizationId: seeded.organizationId, userId: seeded.userId, title: 'Empty chat' },
    })
    const { GET } = await import('../chat/sessions/route')
    const res = await GET(new NextRequest(new URL('http://test/api/assistant/chat/sessions')))
    const data = await res.json()
    assert.equal(data.sessions.length, 1)
    assert.equal(data.sessions[0].id, sessionId)
  })

  test('PATCH records an executed run on an owned message', async () => {
    const { PATCH } = await import('../chat/route')
    const res = await PATCH(
      new NextRequest(new URL('http://test/api/assistant/chat'), {
        method: 'PATCH',
        body: JSON.stringify({
          messageId,
          executedRun: { executionId: 'e1', agentId: 'a1', status: 'pending' },
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.message.executedRun.executionId, 'e1')
    assert.equal(data.message.createdAgent.id, 'a1') // merge, not replace
  })

  test('POST 503s when no model provider is configured', async () => {
    // The test env has no ANTHROPIC_API_KEY/Qwen config, so the provider guard
    // must fire before any DB write — a POST here must not create a session.
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const { POST } = await import('../chat/route')
      const res = await POST(
        new NextRequest(new URL('http://test/api/assistant/chat'), {
          method: 'POST',
          body: JSON.stringify({ message: 'hello' }),
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      assert.equal(res.status, 503)
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous
    }
  })

  test('PATCH 404s on a message the user does not own', async () => {
    const otherSeed = await (await import('@/lib/server/__tests__/test-auth')).seedTestOrg(prisma)
    try {
      const foreign = await prisma.assistantChatSession.create({
        data: { organizationId: otherSeed.organizationId, userId: otherSeed.userId },
      })
      const foreignMessage = await prisma.assistantChatMessage.create({
        data: {
          organizationId: otherSeed.organizationId,
          userId: otherSeed.userId,
          sessionId: foreign.id,
          role: 'assistant',
          content: 'x',
        },
      })
      const { PATCH } = await import('../chat/route')
      const res = await PATCH(
        new NextRequest(new URL('http://test/api/assistant/chat'), {
          method: 'PATCH',
          body: JSON.stringify({
            messageId: foreignMessage.id,
            executedRun: { executionId: 'e2', agentId: 'a2', status: 'pending' },
          }),
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      assert.equal(res.status, 404)
    } finally {
      await otherSeed.cleanup()
    }
  })
} else {
  test('assistant chat tests need TEST_DATABASE_URL', { skip: true }, () => {})
}
