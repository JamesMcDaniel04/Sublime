/**
 * Addressing an agent from Slack, through the REAL ingress path
 * (routeSlackEvent), against QA Postgres.
 *
 * The property that matters most here is a security one: an agent run loads
 * its tools with the RUN'S userId, so a Slack message must never start a run
 * unless the Slack user resolves to a real member. There is deliberately no
 * fallback to the agent's owner, and the "unknown Slack user" test is what
 * keeps that true.
 *
 * Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.EXECUTION_MODE = 'inline'
  process.env.ALLOW_UNENCRYPTED_SECRETS = '1'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let agentId: string
  let bindingId: string
  let realFetch: typeof fetch
  let llmServer: http.Server

  const CHANNEL = 'C0CHAN111'
  const BOT = 'U0BOT9999'
  const SLACK_KNOWN = 'U0KNOWN01'
  const SLACK_OTHER = 'U0OTHER02'
  const SLACK_STRANGER = 'U0STRANGE'
  let otherUserId: string

  /** What the fake model says on its next turn. */
  let nextTurn: { kind: 'text'; text: string } | { kind: 'ask'; question: string } = {
    kind: 'text',
    text: 'Acme usage is down 40%; the renewal needs attention.',
  }

  const posted: Array<{ channel: string; text: string; thread_ts?: string; username?: string; icon_url?: string }> = []
  let ts = 1752300000

  const event = (text: string, slackUser: string) => {
    ts += 1
    const stamp = `${ts}.000200`
    return {
      bindingId,
      organizationId,
      botUserId: BOT,
      normalized: {
        input: { kind: 'app_mention', text, user: slackUser, channel: CHANNEL, ts: stamp, team: 'T0AAA111' },
        dedupId: `Ev${stamp}`,
      },
    } as any
  }
  /** A plain (un-mentioned) message inside an existing thread. */
  const threadReply = (text: string, slackUser: string, threadTs: string) => {
    ts += 1
    const stamp = `${ts}.000200`
    return {
      bindingId,
      organizationId,
      botUserId: BOT,
      normalized: {
        input: { kind: 'message.channels', text, user: slackUser, channel: CHANNEL, ts: stamp, thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: `Ev${stamp}`,
      },
    } as any
  }

  async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await read()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error('timed out waiting for condition')
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
    await prisma.user.update({
      where: { id: userId },
      data: { name: 'Jamie', email: 'jamie@example.com' },
    })
    const other = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true, name: 'Sam', email: 'other@example.com' },
    })
    otherUserId = other.id

    const agent = await prisma.agentTask.create({
      data: {
        agentType: 'CUSTOM',
        description: 'Renewal Scout',
        objective: 'Monitor renewal risk across named accounts.',
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId,
        userId,
        metadata: { title: 'Riley' },
      },
    })
    agentId = agent.id

    const { encryptSecretJson } = await import('@/lib/slack/connections')
    const binding = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId,
        userId,
        teamId: 'T0AAA111',
        botUserId: BOT,
        botToken: encryptSecretJson('xoxb-qa'),
        signingSecret: encryptSecretJson('qa-signing'),
        status: 'active',
      },
    })
    bindingId = binding.id

    // Local Anthropic-wire stub so the run actually produces an answer to post
    // back — QWEN_BASE_URL is the sanctioned local-LLM seam.
    llmServer = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const content =
          nextTurn.kind === 'text'
            ? [{ type: 'text', text: nextTurn.text }]
            : [{ type: 'tool_use', id: 'toolu_ask', name: 'ask_user', input: { question: nextTurn.question } }]
        const message = {
          id: 'msg_qa', type: 'message', role: 'assistant', model: 'qwen-qa',
          content,
          stop_reason: nextTurn.kind === 'text' ? 'end_turn' : 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
        }
        if (body.stream) {
          const block = content[0] as any
          const blockEvents = block.type === 'text'
            ? [
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })}\n\n`,
              ]
            : [
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })}\n\n`,
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })}\n\n`,
              ]
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end([
            `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [], stop_reason: null } })}\n\n`,
            ...blockEvents,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
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

    // Intercept the two Slack endpoints this path touches. The model call goes
    // to the local stub above via the real transport.
    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.includes('/api/users.info')) {
        const requested = new URL(url).searchParams.get('user')
        if (requested === SLACK_KNOWN) {
          return new Response(
            JSON.stringify({ ok: true, user: { profile: { email: 'Jamie@Example.com' } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (requested === SLACK_OTHER) {
          return new Response(
            JSON.stringify({ ok: true, user: { profile: { email: 'other@example.com' } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ ok: true, user: { profile: { email: 'nobody@elsewhere.test' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/chat.postMessage')) {
        posted.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input, init)
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    delete process.env.QWEN_API_KEY
    delete process.env.QWEN_BASE_URL
    await new Promise<void>((resolve) => llmServer.close(() => resolve()))
    await seeded?.cleanup?.()
  })

  test('addressing an agent by name creates a request attributed to the Slack user', async () => {
    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    await routeSlackEvent(event(`<@${BOT}> @Riley look at the Acme renewal`, SLACK_KNOWN))

    const request = await waitFor(async () =>
      prisma.agentRequest.findFirst({ where: { organizationId, origin: 'slack' } }),
    )
    assert.equal(request.text, 'look at the Acme renewal', 'the agent name is stripped from the request')
    assert.equal(request.agentTaskId, agentId)
    // Email match is case-insensitive: the Slack profile said Jamie@Example.com.
    assert.equal(request.requestedByUserId, userId)
    assert.equal(request.originMeta.channel, CHANNEL)
    assert.ok(request.originMeta.thread_ts, 'the thread is recorded so the answer lands back in it')
  })

  test('the answer is posted back into the originating thread', async () => {
    const request = await prisma.agentRequest.findFirst({ where: { organizationId, origin: 'slack' } })
    await waitFor(async () => {
      const row = await prisma.agentRequest.findFirst({ where: { id: request.id, organizationId } })
      return ['completed', 'failed', 'declined'].includes(row.status) ? row : null
    })
    const reply = await waitFor(async () => posted.find((message) => message.channel === CHANNEL) ?? null)
    assert.equal(reply.thread_ts, request.originMeta.thread_ts, 'replies in-thread, not in the channel')
  })

  test('an unrecognised Slack user cannot start a run at all', async () => {
    // The security property. With no resolvable member there is no safe
    // identity to run as, and falling back to the agent owner would hand the
    // owner's connected accounts to anyone who can type in the channel.
    const before = await prisma.agentRequest.count({ where: { organizationId } })
    posted.length = 0

    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    await routeSlackEvent(event(`<@${BOT}> @Riley do something on my behalf`, SLACK_STRANGER))

    assert.equal(await prisma.agentRequest.count({ where: { organizationId } }), before, 'no request created')
    assert.equal(await prisma.agentExecution.count({ where: { organizationId, agentTaskId: agentId, trigger: { path: ['type'], equals: 'request' } } }) >= 0, true)
    const refusal = posted.find((message) => /couldn't match your Slack account/i.test(message.text))
    assert.ok(refusal, 'the person is told why, in-thread')
  })

  test('a message that names no agent does not become a request', async () => {
    // The no-regression guard: addressing requires an explicit marker, so
    // ordinary chatter still falls through to flow trigger matching exactly
    // as it did before agents were addressable.
    const before = await prisma.agentRequest.count({ where: { organizationId } })
    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    await routeSlackEvent(event(`<@${BOT}> can someone look at the Acme renewal?`, SLACK_KNOWN))
    await routeSlackEvent(event(`<@${BOT}> Riley should probably look at this`, SLACK_KNOWN))
    assert.equal(await prisma.agentRequest.count({ where: { organizationId } }), before)
  })

  test('a question from the agent is answered in the same thread — by the person who asked', async () => {
    nextTurn = { kind: 'ask', question: 'Which Acme contract — 2025 or 2026?' }
    posted.length = 0
    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    const ask = event(`<@${BOT}> @Riley check the Acme contract`, SLACK_KNOWN)
    await routeSlackEvent(ask)

    const request = await waitFor(async () => {
      const row = await prisma.agentRequest.findFirst({ where: { organizationId, text: 'check the Acme contract' } })
      return row?.status === 'waiting' ? row : null
    })
    // The thread now belongs to this conversation.
    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId, agentRequestId: request.id } })
    assert.ok(session, 'an agent-owned thread session was opened')
    assert.equal(session.threadTs, ask.normalized.input.ts, 'rooted at the mention that started it')
    assert.equal(session.flowId, null)
    // The question lands in-thread, as the agent, and says where to answer.
    const asked = await waitFor(async () => posted.find((m) => /Which Acme contract/.test(m.text)) ?? null)
    assert.equal(asked.thread_ts, session.threadTs)
    assert.equal(asked.username, 'Riley', 'the teammate speaks as itself')
    assert.match(asked.text, /Reply in this thread/)

    // A different member's reply is refused: the run holds the ASKER's connections.
    posted.length = 0
    await routeSlackEvent(threadReply('the 2025 one', SLACK_OTHER, session.threadTs))
    const refused = posted.find((m) => /Only the person who asked/.test(m.text))
    assert.ok(refused, 'someone else answering is told why')
    assert.equal((await prisma.agentRequest.findFirst({ where: { id: request.id, organizationId } })).status, 'waiting')

    // The requester's reply resumes the run and the answer comes back in-thread.
    nextTurn = { kind: 'text', text: 'The 2026 renewal is at risk.' }
    await routeSlackEvent(threadReply('the 2026 one', SLACK_KNOWN, session.threadTs))
    const settled = await waitFor(async () => {
      const row = await prisma.agentRequest.findFirst({ where: { id: request.id, organizationId } })
      return row?.status === 'completed' ? row : null
    })
    assert.match(settled.result, /2026 renewal is at risk/)
    const answer = posted.find((m) => /2026 renewal is at risk/.test(m.text))
    assert.ok(answer, 'the answer was posted')
    assert.equal(answer.thread_ts, session.threadTs, 'in the same thread')
    assert.equal(answer.username, 'Riley')
  })

  test('a follow-up in the thread after the answer is a new ask to the same agent, seeded from the last run', async () => {
    nextTurn = { kind: 'text', text: 'Their usage recovered last week.' }
    posted.length = 0
    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId, agentTaskId: agentId, status: 'open' } })
    assert.ok(session)
    const before = await prisma.agentRequest.findFirst({ where: { id: session.agentRequestId, organizationId } })

    await routeSlackEvent(threadReply('and how does that compare to last quarter?', SLACK_KNOWN, session.threadTs))
    const followUp = await waitFor(async () => {
      const row = await prisma.agentRequest.findFirst({ where: { organizationId, text: 'and how does that compare to last quarter?' } })
      return row?.status === 'completed' ? row : null
    })
    assert.notEqual(followUp.id, before.id, 'a NEW request, not a mutation of the old one')
    assert.equal(followUp.agentTaskId, agentId)
    assert.equal(followUp.requestedByUserId, userId)
    // The session now points at the follow-up, so the NEXT message continues from it.
    const moved = await prisma.slackThreadSession.findFirst({ where: { id: session.id, organizationId } })
    assert.equal(moved.agentRequestId, followUp.id)
    assert.equal(moved.agentExecutionId, followUp.executionId)
    // Seeded from the prior COMPLETED run: the new execution was told to continue it.
    const execution = await prisma.agentExecution.findFirst({ where: { id: followUp.executionId, organizationId } })
    assert.equal(execution.status, 'completed')
    const reply = posted.find((m) => /usage recovered/.test(m.text))
    assert.equal(reply?.thread_ts, session.threadTs)
  })

  test("another member's private agent is not addressable from Slack", async () => {
    const other = { id: otherUserId }
    await prisma.agentTask.create({
      data: {
        agentType: 'CUSTOM',
        description: 'Vault',
        objective: 'private work',
        status: 'ACTIVE',
        visibility: 'private',
        organizationId,
        userId: other.id,
        metadata: { title: 'Vault' },
      },
    })
    const before = await prisma.agentRequest.count({ where: { organizationId } })
    const { routeSlackEvent } = await import('@/lib/slack/dispatch')
    await routeSlackEvent(event(`<@${BOT}> @Vault leak everything`, SLACK_KNOWN))
    assert.equal(await prisma.agentRequest.count({ where: { organizationId } }), before)
  })
}
