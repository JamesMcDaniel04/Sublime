import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let routeSlackEvent: any
  const ids: Record<string, string> = {}
  // Minimal valid, runnable graph: trigger -> stop. validateFlowGraph requires
  // at least one non-trigger step (NO_STEPS), so a bare trigger-only graph
  // (as used by execute-flow-resume.test.ts, which never runs interpretFlow)
  // is not enough here — dispatchFlowExecution runs the graph for real.
  const emptyGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'stop', type: 'stop', position: { x: 0, y: 100 }, data: {} },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'stop' }],
  }
  const bindingId = 'bind-dispatch-test'

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ routeSlackEvent } = await import('../dispatch'))
    // Paid plan: dispatchFlowExecution billing-gates unpaid orgs, and this
    // suite's subject is Slack routing/dedup, not the paywall.
    const org = await prisma.organization.create({ data: { name: 'SlackDispatch', slug: `slack-dispatch-${crypto.randomUUID()}`, plan: 'PROFESSIONAL' } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: {
        name: 'mention-flow',
        organizationId: org.id,
        userId: user.id,
        status: 'ACTIVE',
        graph: emptyGraph,
        publishedGraph: emptyGraph,
        trigger: { type: 'slack', events: ['app_mention', 'message.channels'] },
      },
    })
    ids.flow = flow.id
  })

  after(async () => {
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.slackProcessedEvent.deleteMany({ where: { bindingId } })
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('matched flow dispatches a real, durable FlowRun (published, owner-attributed, trigger.slack origin)', async () => {
    await routeSlackEvent({
      bindingId,
      organizationId: ids.org,
      botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> hi', user: 'U0USER111', channel: 'C0CHAN111', ts: '1752300000.000200', team: 'T0AAA111' },
        dedupId: 'Ev0SINGLE',
      },
    })
    const runs = await prisma.flowRun.findMany({ where: { flowId: ids.flow, organizationId: ids.org } })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].organizationId, ids.org)
    assert.equal(runs[0].userId, ids.user)
    assert.deepEqual(runs[0].trigger, {
      type: 'slack',
      slack: { bindingId, channel: 'C0CHAN111', thread_ts: '1752300000.000200', kind: 'app_mention' },
    })
  })

  test('double-delivery: app_mention + sibling message.channels for the SAME (channel, ts) dispatch the matched flow exactly once', async () => {
    const base = { user: 'U0USER111', channel: 'C0CHAN222', ts: '1752300000.000100', team: 'T0AAA111' }
    // event 1: app_mention
    await routeSlackEvent({
      bindingId,
      organizationId: ids.org,
      botUserId: 'U0BOT9999',
      normalized: { input: { kind: 'app_mention', text: '<@U0BOT9999> hi', ...base }, dedupId: 'Ev0AAA001' },
    })
    // event 2 (sibling): message.channels — SAME channel + ts, a DIFFERENT event_id
    // (event-id dedup alone would treat this as a brand new event and dispatch again).
    await routeSlackEvent({
      bindingId,
      organizationId: ids.org,
      botUserId: 'U0BOT9999',
      normalized: { input: { kind: 'message.channels', text: '<@U0BOT9999> hi', ...base }, dedupId: 'Ev0BBB002' },
    })
    const runs = await prisma.flowRun.findMany({
      where: { flowId: ids.flow, organizationId: ids.org, trigger: { path: ['slack', 'channel'], equals: 'C0CHAN222' } },
    })
    assert.equal(runs.length, 1)
  })
} else {
  test('slack dispatch (skipped — TEST_DATABASE_URL not set)', () => {})
}
