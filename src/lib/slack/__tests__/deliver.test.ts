import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

  let prisma: any
  let seeded: any
  let bindingId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { encryptSecretJson } = await import('@/lib/slack/connections')
    seeded = await seedTestOrg(prisma)
    const binding = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: seeded.organizationId, teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999',
        botToken: encryptSecretJson('xoxb-deliver'), signingSecret: encryptSecretJson('sig'),
      },
    })
    bindingId = binding.id
  })

  after(async () => {
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const stubFetch = (posts: { url: string; body: any; auth?: string }[]) =>
    (async (url: any, init: any) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)), auth: init.headers?.Authorization })
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch

  test('succeeded run posts formatted output to the origin thread with the decrypted token', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const flow = await prisma.flow.create({ data: { name: 'Deliver flow', organizationId: seeded.organizationId, userId: seeded.userId } })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, status: 'succeeded', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: flow.id, flowRunId: run.id,
      status: 'succeeded', output: 'Deployed v1.2',
      origin: { bindingId, channel: 'C0CHAN111', thread_ts: '1752300000.000100', kind: 'app_mention' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, 'https://slack.com/api/chat.postMessage')
    assert.equal(posts[0].auth, 'Bearer xoxb-deliver')
    assert.deepEqual(posts[0].body, { channel: 'C0CHAN111', text: 'Deployed v1.2', thread_ts: '1752300000.000100' })
  })

  test('slash-command run replies via response_url', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const flow = await prisma.flow.create({ data: { name: 'Slash flow', organizationId: seeded.organizationId, userId: seeded.userId } })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, status: 'succeeded', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: flow.id, flowRunId: run.id,
      status: 'succeeded', output: 'done',
      origin: { bindingId, channel: 'C0CHAN111', response_url: 'https://hooks.slack.com/commands/T/1/a', kind: 'slash_command' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, 'https://hooks.slack.com/commands/T/1/a')
    assert.equal(posts[0].body.response_type, 'in_channel')
  })

  test('a FAILED last agent step is NOT recorded as the session seed — only a succeeded step qualifies', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const flow = await prisma.flow.create({ data: { name: 'Seed-guard flow', organizationId: seeded.organizationId, userId: seeded.userId } })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, status: 'failed', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    // A succeeded agent step earlier in the run, then a LATER failed agent
    // step (e.g. a retry-loop's last attempt) — the failed step ends on a
    // dangling tool_use with no result, so it must never seed the next reply.
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-1', order: 0, status: 'succeeded', agentExecutionId: 'exec-good' },
    })
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'agent-2', order: 1, status: 'failed', agentExecutionId: 'exec-bad' },
    })
    const session = await prisma.slackThreadSession.create({
      data: {
        organizationId: seeded.organizationId, bindingId, channel: 'C0SEEDGUARD1', threadTs: '1752301000.000100',
        flowId: flow.id, flowRunId: run.id, status: 'open',
      },
    })

    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: flow.id, flowRunId: run.id,
      status: 'failed', output: null, error: 'boom',
      origin: { bindingId, channel: 'C0SEEDGUARD1', thread_ts: '1752301000.000100', kind: 'app_mention' },
      fetchImpl: stubFetch(posts),
    })

    const after = await prisma.slackThreadSession.findFirst({ where: { id: session.id } })
    assert.equal(after.agentExecutionId, 'exec-good', 'the seed stays the last SUCCEEDED step, never the later failed one')
  })

  test('unknown binding or wrong org posts nothing', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: 'f', flowRunId: 'r',
      status: 'failed', output: null, error: 'x',
      origin: { bindingId: 'nonexistent', channel: 'C1' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 0)
  })
} else {
  test('slack deliver (skipped — TEST_DATABASE_URL not set)', () => {})
}
