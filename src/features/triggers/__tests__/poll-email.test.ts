/**
 * Email polling, with exactly-once as the property under test.
 *
 * A message that triggers twice means a duplicate reply sent or a duplicate
 * ticket filed. That is the failure people notice, so it is tested against a
 * real database — the dedupe claim is a transaction with SELECT … FOR UPDATE,
 * and an in-memory stub would prove nothing about it.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key'
  // The names lib/google/oauth.ts actually reads.
  process.env.GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? 'test-client'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? 'test-secret'

  test('email polling', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { encryptSecret } = await import('@/lib/crypto/secrets')
    const { pollEmailTrigger } = await import('../poll-email')

    const seeded = await seedTestOrg(prisma)
    const realFetch = globalThis.fetch

    /** Which message ids the mailbox currently returns. */
    let mailbox = ['msg-1', 'msg-2']

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

      if (url.includes('oauth2') || url.includes('token')) {
        return json({ access_token: 'test-access-token', expires_in: 3600 })
      }
      if (url.includes('/messages?')) {
        return json({ messages: mailbox.map((id) => ({ id })) })
      }
      if (url.includes('/messages/')) {
        const id = decodeURIComponent(url.split('/messages/')[1].split('?')[0])
        return json({
          id, threadId: `thread-${id}`, internalDate: '1756143600000', snippet: 'hi',
          payload: {
            headers: [
              { name: 'From', value: 'sender@acme.com' },
              { name: 'Subject', value: `Subject for ${id}` },
            ],
            body: { data: Buffer.from(`Body of ${id}`).toString('base64url') },
          },
        })
      }
      return new Response('{}', { status: 404 })
    }) as typeof globalThis.fetch

    after(async () => {
      globalThis.fetch = realFetch
      await seeded.cleanup()
      await prisma.$disconnect()
    })

    const flow = await prisma.flow.create({
      data: {
        name: 'Email triage',
        organizationId: seeded.organizationId, userId: seeded.userId,
        trigger: { type: 'email' },
        graph: { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'email' } } }], edges: [] },
        status: 'ACTIVE',
      },
      select: { id: true },
    })

    const connection = await prisma.googleOAuthConnection.create({
      data: {
        organizationId: seeded.organizationId, userId: seeded.userId,
        service: 'google-mail', accountEmail: 'ops@example.com',
        refreshTokenEnc: encryptSecret('refresh-token'), status: 'connected',
      },
      select: { id: true },
    })

    const poll = () => pollEmailTrigger({
      flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId,
      connectionId: connection.id, config: {},
    })

    await t.test('a first poll triggers every new message', async () => {
      const result = await poll()
      assert.equal(result.checked, 2)
      assert.equal(result.triggered, 2)
    })

    // The load-bearing property.
    await t.test('polling again triggers nothing', async () => {
      const result = await poll()
      assert.equal(result.checked, 2)
      assert.equal(result.triggered, 0, 'a message triggered twice')
    })

    await t.test('only genuinely new mail triggers', async () => {
      mailbox = ['msg-1', 'msg-2', 'msg-3']
      const result = await poll()
      assert.equal(result.triggered, 1, 'the wrong number of messages triggered')
    })

    // Two pollers racing must not both claim the same message — the reason
    // dedupe is a locked transaction rather than a read-then-write.
    await t.test('concurrent polls cannot both claim a message', async () => {
      mailbox = ['race-1', 'race-2']
      const [a, b] = await Promise.all([poll(), poll()])
      assert.equal(a.triggered + b.triggered, 2, 'a racing poll double-triggered')
    })

    await t.test('an empty mailbox is not an error', async () => {
      mailbox = []
      const result = await poll()
      assert.deepEqual(result, { checked: 0, triggered: 0 })
    })

    await t.test('a run is created carrying the parsed message', async () => {
      const run = await prisma.flowRun.findFirst({
        where: { flowId: flow.id, organizationId: seeded.organizationId },
        orderBy: { startedAt: 'asc' },
      })
      assert.ok(run, 'no run was created for a triggered message')
      const input = run.input as { prompt?: unknown } | null
      assert.ok(JSON.stringify(input).includes('sender@acme.com'), 'the message did not reach the run')
    })

    await t.test('a mailbox that cannot be read fails loudly', async () => {
      const previous = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.includes('oauth2') || url.includes('token')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
            status: 200, headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('nope', { status: 500 })
      }) as typeof globalThis.fetch

      await assert.rejects(() => poll(), /could not be read/i)
      globalThis.fetch = previous
    })

    await t.test('an unknown connection is refused', async () => {
      await assert.rejects(
        () => pollEmailTrigger({
          flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId,
          connectionId: 'no-such-connection', config: {},
        }),
        /not available/i,
      )
    })
  })
}
