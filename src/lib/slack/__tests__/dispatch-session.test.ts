import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// Ingress precedence + session lifecycle, exercised through the real
// `routeSlackEvent` entry point against a real Postgres DB — proving the
// hard invariants a reviewer will hard-test:
//   - open + waiting session -> RESUMES that run (no new run, no double-processing)
//   - open + settled session -> CONTINUES (a NEW seeded run; session repoints to it)
//   - no session for the thread -> falls through to normal trigger matching, unchanged
//   - no thread_ts at all -> falls through to normal trigger matching, unchanged
//   - threadMemory:false flows never create/consult a session (single-shot, Task 5/6 behavior)
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let routeSlackEvent: any
  let dispatchFlowExecution: any
  const ids: Record<string, string> = {}
  const bindingId = 'bind-session-test'

  // trigger -> stop: settles immediately (no agent node — keeps these tests
  // LLM-free while still exercising the real dispatch/session machinery).
  const stopGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'stop', type: 'stop', position: { x: 0, y: 100 }, data: {} },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'stop' }],
  }
  // trigger -> humanReview: pauses `waiting` so we can exercise the resume path.
  const hrGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
      { id: 'hr', type: 'humanReview', position: { x: 0, y: 100 }, data: { message: 'need info?' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ routeSlackEvent } = await import('../dispatch'))
    ;({ dispatchFlowExecution } = await import('@/features/flows/execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'SlackSession', slug: `slack-session-${crypto.randomUUID()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
    ids.user = user.id
  })

  after(async () => {
    await prisma.slackThreadSession.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flowRun.deleteMany({ where: { organizationId: ids.org } })
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.slackProcessedEvent.deleteMany({ where: { bindingId } })
    await prisma.user.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('open + WAITING session: the reply RESUMES that run — no new run, no double-processing', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'resume-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: hrGraph, publishedGraph: hrGraph,
        // channels-restricted: this shared-org test file has many concurrent
        // fixtures — an unrestricted trigger would also match OTHER tests'
        // fallthrough events for the same org and steal their session via
        // the shared (bindingId, channel, threadTs) upsert key.
        trigger: { type: 'slack', events: ['message.channels'], channels: ['C0RESUME1'], threadMemory: true },
      },
    })
    const channel = 'C0RESUME1'
    const threadTs = '1752300100.000100'
    const paused = await dispatchFlowExecution({
      flowId: flow.id, organizationId: ids.org, userId: ids.user, input: 'start', usePublished: true,
      trigger: { type: 'slack', slack: { bindingId, channel, thread_ts: threadTs, kind: 'message.channels' } },
    })
    assert.equal((paused as any).status, 'waiting')
    await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel, threadTs, flowId: flow.id, flowRunId: (paused as any).flowRunId, status: 'open' },
    })

    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'message.channels', text: 'my answer', user: 'U0USER111', channel, ts: '1752300100.000200', thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0RESUME1',
      },
    })

    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1, 'no new run — the existing waiting run was resumed, not duplicated')
    assert.equal(runs[0].id, (paused as any).flowRunId)
    assert.equal(runs[0].status, 'succeeded')
    assert.equal(runs[0].output, 'my answer', 'the thread reply became the paused humanReview step\'s output')

    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs } })
    assert.equal(session.flowRunId, (paused as any).flowRunId, 'resume never repoints the session to a different run')
  })

  test('open + SETTLED session: continues the conversation with a NEW run, session repoints to it', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'continue-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph,
        trigger: { type: 'slack', events: ['message.channels'], channels: ['C0CONTINUE1'], threadMemory: true },
      },
    })
    const channel = 'C0CONTINUE1'
    const threadTs = '1752300200.000100'
    const priorRun = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'succeeded', input: { prompt: 'start' } },
    })
    await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel, threadTs, flowId: flow.id, flowRunId: priorRun.id, agentExecutionId: 'exec-prior', status: 'open' },
    })

    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'message.channels', text: 'follow up', user: 'U0USER111', channel, ts: '1752300200.000200', thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0CONTINUE1',
      },
    })

    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org }, orderBy: { startedAt: 'asc' } })
    assert.equal(runs.length, 2, 'a NEW run was created — the prior settled run was never re-executed')
    const newRun = runs.find((r: any) => r.id !== priorRun.id)
    assert.ok(newRun)
    assert.equal(newRun.status, 'succeeded')

    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs } })
    assert.equal(session.flowRunId, newRun.id, 'the session now points at the new run')
    assert.equal(session.status, 'open')
  })

  test('thread_ts with NO open session falls through to normal trigger matching, unchanged', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'normal-match-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph,
        trigger: { type: 'slack', events: ['app_mention'] },
      },
    })
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> hi', user: 'U0USER111', channel: 'C0NOSESSION1', ts: '1752300300.000100', thread_ts: '1752300300.000100', team: 'T0AAA111' },
        dedupId: 'Ev0NOSESSION1',
      },
    })
    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1, 'normal matching dispatched exactly as it would without any session in play')
  })

  test('no thread_ts at all falls through to normal trigger matching, unchanged', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'no-thread-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph,
        trigger: { type: 'slack', events: ['slash_command'], command: '/deploy' },
      },
    })
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'slash_command', text: '', user: 'U0USER111', channel: 'C0NOTHREAD1', ts: '', command: '/deploy', team: 'T0AAA111' },
        dedupId: 'Ev0NOTHREAD1',
      },
    })
    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1)
  })

  test('threadMemory:false flow never creates a session — single-turn, one-shot, exactly Task 5/6 behavior', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'no-memory-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph,
        trigger: { type: 'slack', events: ['app_mention'] }, // threadMemory NOT set
      },
    })
    const channel = 'C0NOMEMORY1'
    const threadTs = '1752300400.000100'
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> hi', user: 'U0USER111', channel, ts: threadTs, thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0NOMEMORY1',
      },
    })
    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1)
    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs } })
    assert.equal(session, null, 'no threadMemory -> no session ever created')

    // A second message in the SAME thread must match normally again (a
    // fresh run each time) rather than being picked up as a continuation —
    // there is no session for it to continue.
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> again', user: 'U0USER111', channel, ts: '1752300400.000200', thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0NOMEMORY2',
      },
    })
    const runsAfter = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runsAfter.length, 2, 'each message dispatches its own one-shot run, never a continuation')
  })

  test('threadMemory:true flow: normal-match dispatch opens a session, and the NEXT in-thread reply is picked up as a continuation', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'end-to-end-memory-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph,
        trigger: { type: 'slack', events: ['app_mention'], threadMemory: true },
      },
    })
    const channel = 'C0E2EMEMORY1'
    const threadTs = '1752300500.000100'
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> hi', user: 'U0USER111', channel, ts: threadTs, thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0E2E1',
      },
    })
    const firstRuns = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(firstRuns.length, 1)
    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs } })
    assert.ok(session, 'the first dispatch must open a session for this thread')
    assert.equal(session.flowRunId, firstRuns[0].id)

    // A reply in the SAME thread is now a continuation, not a fresh trigger
    // match (the flow's trigger config would ALSO match app_mention here —
    // precedence must win, producing exactly one additional run, not two).
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'app_mention', text: '<@U0BOT9999> follow up', user: 'U0USER111', channel, ts: '1752300500.000200', thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0E2E2',
      },
    })
    const allRuns = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(allRuns.length, 2, 'exactly one continuation run — precedence prevented a second, duplicate normal-match dispatch')
  })

  test('cross-thread isolation: a DIFFERENT thread in the same channel/binding never bleeds into this thread\'s session', async () => {
    const flowA = await prisma.flow.create({
      data: {
        name: 'thread-a-flow', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph, trigger: { type: 'slack', events: ['message.channels'], channels: ['C0CROSSTHREAD1'], threadMemory: true },
      },
    })
    const flowB = await prisma.flow.create({
      data: {
        name: 'thread-b-flow', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: stopGraph, trigger: { type: 'slack', events: ['message.channels'], channels: ['C0CROSSTHREAD1'], threadMemory: true },
      },
    })
    const channel = 'C0CROSSTHREAD1'
    const threadA = '1752300700.000100'
    const threadB = '1752300700.000900' // different thread root, same channel/binding
    const runA = await prisma.flowRun.create({
      data: { flowId: flowA.id, organizationId: ids.org, userId: ids.user, status: 'succeeded', input: { prompt: 'start a' } },
    })
    const runB = await prisma.flowRun.create({
      data: { flowId: flowB.id, organizationId: ids.org, userId: ids.user, status: 'succeeded', input: { prompt: 'start b' } },
    })
    await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel, threadTs: threadA, flowId: flowA.id, flowRunId: runA.id, status: 'open' },
    })
    await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel, threadTs: threadB, flowId: flowB.id, flowRunId: runB.id, status: 'open' },
    })

    // A reply in thread A must continue flowA only — flowB/thread B untouched.
    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'message.channels', text: 'reply in a', user: 'U0USER111', channel, ts: '1752300700.000200', thread_ts: threadA, team: 'T0AAA111' },
        dedupId: 'Ev0CROSSTHREADA',
      },
    })
    const runsA = await prisma.flowRun.findMany({ where: { flowId: flowA.id, organizationId: ids.org } })
    const runsB = await prisma.flowRun.findMany({ where: { flowId: flowB.id, organizationId: ids.org } })
    assert.equal(runsA.length, 2, 'thread A got its continuation run')
    assert.equal(runsB.length, 1, 'thread B was never touched by thread A\'s reply')

    const sessionB = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs: threadB } })
    assert.equal(sessionB.flowRunId, runB.id, 'thread B\'s session is unchanged')
  })

  test('unpublished/deleted flow: an open session for it closes and the event falls through to normal matching', async () => {
    const flow = await prisma.flow.create({
      data: {
        name: 'unpublish-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE',
        graph: stopGraph, publishedGraph: null, // no published graph -> flowActive is false
        trigger: { type: 'slack', events: ['message.channels'], threadMemory: true },
      },
    })
    const channel = 'C0UNPUBLISH1'
    const threadTs = '1752300800.000100'
    const priorRun = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'succeeded', input: { prompt: 'start' } },
    })
    await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel, threadTs, flowId: flow.id, flowRunId: priorRun.id, status: 'open' },
    })

    await routeSlackEvent({
      bindingId, organizationId: ids.org, botUserId: 'U0BOT9999',
      normalized: {
        input: { kind: 'message.channels', text: 'hi again', user: 'U0USER111', channel, ts: '1752300800.000200', thread_ts: threadTs, team: 'T0AAA111' },
        dedupId: 'Ev0UNPUBLISH1',
      },
    })
    // No new run for the now-unpublished flow (fallthrough dispatched nothing
    // to it — there is no matching ACTIVE flow with a publishedGraph for this
    // event; it just doesn't error).
    const runs = await prisma.flowRun.findMany({ where: { flowId: flow.id, organizationId: ids.org } })
    assert.equal(runs.length, 1, 'the unpublished flow gained no new run')
    const session = await prisma.slackThreadSession.findFirst({ where: { organizationId: ids.org, bindingId, channel, threadTs } })
    assert.equal(session.status, 'closed', 'the dead conversation session was closed')
  })

  test('closeSession + closeStaleSlackSessions: explicit close and the 7-day idle sweep', async () => {
    const { closeSession, closeStaleSlackSessions } = await import('../session')
    const flow = await prisma.flow.create({
      data: { name: 'sweep-target', organizationId: ids.org, userId: ids.user, status: 'ACTIVE', graph: stopGraph, publishedGraph: stopGraph },
    })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: ids.org, userId: ids.user, status: 'succeeded', input: { prompt: 'x' } },
    })
    const fresh = await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel: 'C0SWEEP1', threadTs: '1752300900.000100', flowId: flow.id, flowRunId: run.id, status: 'open' },
    })
    await closeSession({ organizationId: ids.org, id: fresh.id })
    const closed = await prisma.slackThreadSession.findFirst({ where: { id: fresh.id } })
    assert.equal(closed.status, 'closed')

    const stale = await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel: 'C0SWEEP2', threadTs: '1752300900.000200', flowId: flow.id, flowRunId: run.id, status: 'open' },
    })
    // Backdate updatedAt past the 7-day cutoff (updatedAt is @updatedAt-managed
    // by Prisma on normal writes, so a raw query is needed to set it directly).
    await prisma.$executeRawUnsafe(
      `UPDATE slack_thread_sessions SET "updatedAt" = now() - interval '8 days' WHERE id = $1`,
      stale.id,
    )
    const stillFresh = await prisma.slackThreadSession.create({
      data: { organizationId: ids.org, bindingId, channel: 'C0SWEEP3', threadTs: '1752300900.000300', flowId: flow.id, flowRunId: run.id, status: 'open' },
    })

    const closedCount = await closeStaleSlackSessions()
    assert.ok(closedCount >= 1)
    const staleAfter = await prisma.slackThreadSession.findFirst({ where: { id: stale.id } })
    assert.equal(staleAfter.status, 'closed', 'idle 8+ days -> swept closed')
    const stillFreshAfter = await prisma.slackThreadSession.findFirst({ where: { id: stillFresh.id } })
    assert.equal(stillFreshAfter.status, 'open', 'recently active session survives the sweep')
  })
} else {
  test('slack session precedence (skipped — TEST_DATABASE_URL not set)', () => {})
}
