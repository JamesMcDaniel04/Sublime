/**
 * Human-addressed agent requests, end to end through the REAL surfaces:
 * POST /api/agents/[id]/requests (the goal composer's call), the real agent
 * runtime, and GET /api/goals/[id]/requests (what the composer reads back).
 *
 * The model runs for real against a local Anthropic-wire stub via
 * QWEN_BASE_URL — the sanctioned local-LLM seam — so the decline path is
 * exercised as an actual tool call rather than a simulated one. That matters:
 * decline_request settling a request as `declined` is the whole reason the
 * "objective frames, request specifies" rule is enforceable, and asserting it
 * against a mock would prove nothing about the runtime.
 *
 * Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // Run in-process so the detached dispatch actually executes here.
  process.env.EXECUTION_MODE = 'inline'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let agentId: string
  let goalId: string
  let llmServer: http.Server

  /** Swapped per test to script the model's next turn. */
  let nextTurn: { kind: 'text'; text: string } | { kind: 'decline'; reason: string } | { kind: 'ask'; question: string } = {
    kind: 'text',
    text: 'Acme is 40% below its usual usage; the renewal is at risk.',
  }

  const contentFor = () =>
    nextTurn.kind === 'text'
      ? [{ type: 'text', text: nextTurn.text }]
      : nextTurn.kind === 'ask'
        ? [{ type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: { question: nextTurn.question } }]
        : [{ type: 'tool_use', id: 'toolu_decline', name: 'decline_request', input: { reason: nextTurn.reason } }]

  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (path: string) => new NextRequest(`http://localhost${path}`, { method: 'GET' })

  /** Poll until the request reaches one of the given statuses. */
  async function waitForStatus(requestId: string, statuses: string[], timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const row = await prisma.agentRequest.findFirst({ where: { id: requestId, organizationId } })
      if (row && statuses.includes(row.status)) return row
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error(`request ${requestId} never reached ${statuses.join('/')}`)
  }
  const waitForSettle = (requestId: string) => waitForStatus(requestId, ['completed', 'failed', 'declined', 'cancelled'])

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
    await prisma.user.update({ where: { id: userId }, data: { name: 'Jamie' } })

    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const message = {
          id: 'msg_qa',
          type: 'message',
          role: 'assistant',
          model: 'qwen-qa',
          content: contentFor(),
          stop_reason: nextTurn.kind === 'text' ? 'end_turn' : 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
        if (body.stream) {
          const blocks = message.content.map((block: any, index: number) => {
            if (block.type === 'text') {
              return [
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}\n\n`,
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}\n\n`,
                `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
              ].join('')
            }
            return [
              `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
            ].join('')
          })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            [
              `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })}\n\n`,
              ...blocks,
              `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
              `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
            ].join(''),
          )
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(message))
        }
      })
    })
    await new Promise<void>((resolve) => llmServer.listen(0, '127.0.0.1', resolve))
    process.env.QWEN_API_KEY = 'qa-key'
    process.env.QWEN_BASE_URL = `http://127.0.0.1:${(llmServer.address() as { port: number }).port}`

    const agent = await prisma.agentTask.create({
      data: {
        agentType: 'CUSTOM',
        description: 'Renewal Scout',
        objective: 'Monitor renewal risk across named accounts and surface accounts needing attention.',
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId,
        userId,
        metadata: { title: 'Riley' },
      },
    })
    agentId = agent.id

    const goal = await prisma.goal.create({
      data: {
        organizationId,
        name: 'Retain Acme',
        kind: 'retention',
        createdByUserId: userId,
        targetValue: 1,
        startValue: 0,
        targetDate: new Date('2026-12-31'),
      },
    })
    goalId = goal.id
  })

  after(async () => {
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    await new Promise<void>((resolve) => llmServer.close(() => resolve()))
    await seeded?.cleanup?.()
  })

  test('a request addressed to an agent runs and comes back answered', async () => {
    nextTurn = { kind: 'text', text: 'Acme is 40% below its usual usage; the renewal is at risk.' }
    const { POST } = await import('../agents/[id]/requests/route')
    const response = await POST(post(`/api/agents/${agentId}/requests`, { text: 'look at the Acme renewal', goalId }))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.ok(payload.requestId, 'returns the request id')
    assert.ok(payload.executionId, 'links a run immediately, before the worker claims it')

    const settled = await waitForSettle(payload.requestId)
    assert.equal(settled.status, 'completed')
    assert.match(settled.result, /renewal is at risk/)
    assert.equal(settled.goalId, goalId)
    assert.equal(settled.origin, 'app')
    assert.equal(settled.requestedByUserId, userId)
    assert.ok(settled.settledAt, 'settledAt is stamped')
  })

  test('the run carries a request trigger origin, not a schedule one', async () => {
    const execution = await prisma.agentExecution.findFirst({
      where: { organizationId, agentTaskId: agentId },
      orderBy: { startedAt: 'desc' },
    })
    assert.equal(execution.trigger.type, 'request')
    assert.ok(execution.trigger.requestId)
  })

  test('the requester is notified that the agent answered — once, not twice', async () => {
    const notifications = await prisma.notification.findMany({
      where: { organizationId, userId, type: { startsWith: 'agent.' } },
    })
    const kinds = notifications.map((n: any) => n.type)
    assert.ok(kinds.includes('agent.request.completed'), 'request answered notice sent')
    // The generic run notice is suppressed for request runs — otherwise the
    // requester hears about the same event twice.
    assert.ok(!kinds.includes('agent.completed'), 'no duplicate generic run notice')
  })

  test('an out-of-objective request is DECLINED, and the run itself still completes', async () => {
    nextTurn = { kind: 'decline', reason: 'I monitor renewal risk; drafting a pricing page is outside that.' }
    const { POST } = await import('../agents/[id]/requests/route')
    const response = await POST(post(`/api/agents/${agentId}/requests`, { text: 'draft our Q3 pricing page' }))
    const payload = await response.json()

    const settled = await waitForSettle(payload.requestId)
    assert.equal(settled.status, 'declined')
    assert.match(settled.error, /outside/i)
    assert.equal(settled.result, null, 'a decline produces no answer')

    // A decline is a CORRECT outcome, so the run is a success, not a failure.
    const execution = await prisma.agentExecution.findFirst({
      where: { id: payload.executionId, organizationId },
    })
    assert.equal(execution.status, 'completed')
  })

  test('a question from the agent parks the request as waiting, and the in-app reply settles it', async () => {
    nextTurn = { kind: 'ask', question: 'Which Acme contract — the 2025 or the 2026 renewal?' }
    const { POST } = await import('../agents/[id]/requests/route')
    const payload = await (await POST(post(`/api/agents/${agentId}/requests`, { text: 'check the Acme contract' }))).json()

    const waiting = await waitForStatus(payload.requestId, ['waiting', 'completed', 'failed'])
    assert.equal(waiting.status, 'waiting', 'the ask_user pause is mirrored onto the request')
    const parked = await prisma.agentExecution.findFirst({ where: { id: payload.executionId, organizationId } })
    assert.equal(parked.status, 'waiting_for_input')

    // Answer through the REAL reply route. The resume job carries no
    // requestId of its own — this is the path that used to leave the request
    // stuck at `waiting` after the run had long since finished.
    nextTurn = { kind: 'text', text: 'The 2026 renewal is at risk.' }
    const { POST: reply } = await import('../executions/[id]/reply/route')
    const response = await reply(post(`/api/executions/${payload.executionId}/reply`, { message: 'The 2026 one' }))
    assert.equal(response.status, 200)

    const settled = await waitForSettle(payload.requestId)
    assert.equal(settled.status, 'completed')
    assert.match(settled.result, /2026 renewal is at risk/)
  })

  test('the goal composer reads its requests back, attributed to agent and requester', async () => {
    const { GET } = await import('../goals/[id]/requests/route')
    const response = await GET(get(`/api/goals/${goalId}/requests`))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.items.length, 1, 'only the goal-bound request, not the goal-less one')
    assert.equal(payload.items[0].agentName, 'Riley')
    assert.equal(payload.items[0].requesterName, 'Jamie')
    assert.equal(payload.items[0].status, 'completed')
  })

  test('settling is idempotent — a redelivered job cannot overwrite the answer', async () => {
    const { moveAgentRequest } = await import('@/lib/agents/request-settle')
    const row = await prisma.agentRequest.findFirst({ where: { organizationId, goalId } })

    const again = await moveAgentRequest({
      requestId: row.id,
      organizationId,
      to: 'completed',
      result: 'a second, wrong answer',
    })
    assert.equal(again, false, 'the redelivery is refused')

    const after = await prisma.agentRequest.findFirst({ where: { id: row.id, organizationId } })
    assert.equal(after.result, row.result, 'the original answer survives')
  })

  test("another member's private agent cannot be addressed", async () => {
    const other = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true },
    })
    const theirs = await prisma.agentTask.create({
      data: {
        agentType: 'CUSTOM',
        description: 'Theirs',
        objective: 'private work',
        status: 'ACTIVE',
        visibility: 'private',
        organizationId,
        userId: other.id,
      },
    })
    const { POST } = await import('../agents/[id]/requests/route')
    const response = await POST(post(`/api/agents/${theirs.id}/requests`, { text: 'do my bidding' }))
    assert.equal(response.status, 404)
    const count = await prisma.agentRequest.count({ where: { organizationId, agentTaskId: theirs.id } })
    assert.equal(count, 0, 'no request row is created for a refused address')
  })

  test('an empty request is refused before any run is minted', async () => {
    const before = await prisma.agentExecution.count({ where: { organizationId } })
    const { POST } = await import('../agents/[id]/requests/route')
    const response = await POST(post(`/api/agents/${agentId}/requests`, { text: '   ' }))
    assert.ok(response.status >= 400)
    assert.equal(await prisma.agentExecution.count({ where: { organizationId } }), before)
  })
}
