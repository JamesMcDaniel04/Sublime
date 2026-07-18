/**
 * End-to-end QA drive for the user-behavior-learning pipeline, following the
 * route-smoke protocol: real Postgres (TEST_DATABASE_URL), seeded auth
 * context, REAL route handlers driven with NextRequest objects.
 *
 * Drives: capture (agent/flow/copilot routes) → ledger rows → cron dispatch
 * → per-user pattern inference → eligibility surfaces → suggestion
 * accept/dismiss feedback → retention pruning. LLM-dependent legs (assistant
 * reply, suggestion synthesis output) degrade gracefully without provider
 * keys — this suite asserts the degradation is clean (no phantom rows, claim
 * released), not the LLM output itself.
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'qa-cron-secret'

  const DAY = 24 * 60 * 60 * 1000
  const ROUTINE_AGENT = 'qa-routine-agent'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let agentId: string
  let flowId: string

  const req = (path: string, init?: RequestInit) => new NextRequest(new URL(`http://test${path}`), init as never)
  const post = (path: string, body: unknown) =>
    req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const put = (path: string, body: unknown) =>
    req(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const cronReq = (path: string, secret?: string) =>
    req(path, { headers: secret ? { authorization: `Bearer ${secret}` } : {} })

  const findEvent = (kind: string, resourceId?: string | null) =>
    prisma.userEvent.findFirst({ where: { organizationId, userId, kind, ...(resourceId !== undefined ? { resourceId } : {}) } })

  const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T | null> => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('capture: POST /api/agents writes an agent_created ledger row', async () => {
    const res = await (await import('../agents/route')).POST(post('/api/agents', { title: 'QA Capture Agent', instructions: 'Review the pipeline every Monday.' }))
    assert.equal(res.status, 200)
    const body = await res.json()
    agentId = body.agent.id
    const event = await findEvent('agent_created', agentId)
    assert.ok(event, 'agent_created event missing')
    assert.equal((event.context as any).name, 'QA Capture Agent')
  })

  test('tenant-guard sweep: connector sync persists rows through the guarded client', async () => {
    // Regression for the tenant-guard bug CLASS: syncAgentConnectors ran an
    // unscoped AgentConnector.deleteMany, the guard rejected it, and the
    // swallowed error meant typed connector rows silently never persisted on
    // ANY agent save. This drives the real route and asserts the rows exist —
    // the honest signal, immune to swallowed errors.
    const res = await (await import('../agents/route')).POST(post('/api/agents', {
      title: 'QA Connector Agent', instructions: 'use slack', integrations: ['slack'],
    }))
    assert.equal(res.status, 200)
    const created = (await res.json()).agent
    const connectors = await prisma.agentConnector.findMany({ where: { agentTaskId: created.id, organizationId } })
    assert.equal(connectors.length, 1, 'typed connector rows must persist (guard rejection would leave zero)')
  })

  test('capture: PUT /api/agents writes agent_edited', async () => {
    const res = await (await import('../agents/route')).PUT(put('/api/agents', { id: agentId, title: 'QA Capture Agent v2' }))
    assert.equal(res.status, 200)
    assert.ok(await findEvent('agent_edited', agentId), 'agent_edited event missing')
  })

  test('capture: flow create + edit write flow_created / flow_edited', async () => {
    const flows = await import('../flows/route')
    const created = await flows.POST(post('/api/flows', { name: 'QA Flow' }))
    assert.equal(created.status, 200)
    flowId = (await created.json()).flow.id
    assert.ok(await findEvent('flow_created', flowId), 'flow_created event missing')

    const edited = await flows.PUT(put('/api/flows', { id: flowId, name: 'QA Flow v2' }))
    assert.equal(edited.status, 200)
    const event = await findEvent('flow_edited', flowId)
    assert.ok(event, 'flow_edited event missing')
    assert.equal((event.context as any).graphChanged, false)
  })

  test('capture survives downstream failure: manual agent run without an LLM key', async () => {
    const res = await (await import('../agents/[id]/execute/route')).POST(post(`/api/agents/${agentId}/execute`, {}))
    // No provider key in the QA env — the inline run fails AFTER capture.
    const event = await findEvent('agent_run_manual', agentId)
    assert.ok(event, 'agent_run_manual event missing despite run failure')
    const execution = await prisma.agentExecution.findFirst({ where: { organizationId, agentTaskId: agentId } })
    assert.ok(execution, 'execution row missing')
    assert.ok([500, 200].includes(res.status), `unexpected status ${res.status}`)
  })

  test('capture: copilot prompt recorded before the LLM call', async () => {
    // Without an LLM key the route degrades to its own fallback reply — the
    // capture contract (event recorded pre-LLM) is what this drives.
    const res = await (await import('../flows/copilot/chat/route')).POST(post('/api/flows/copilot/chat', { messages: [{ role: 'user', content: 'Add a summarize step' }] }))
    assert.ok([200, 502, 503].includes(res.status), `unexpected status ${res.status}`)
    assert.ok(await findEvent('copilot_prompt'), 'copilot_prompt event missing')
  })

  test('probe: failed publish writes NO phantom flow_published event', async () => {
    const res = await (await import('../flows/[id]/publish/route')).POST(post(`/api/flows/${flowId}/publish`, {}))
    assert.notEqual(res.status, 200, 'empty flow should not publish')
    assert.equal(await findEvent('flow_published', flowId), null, 'phantom flow_published event')
  })

  test('probe: unauthenticated request is rejected and captures nothing', async () => {
    const { clearTestAuth, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    clearTestAuth()
    const res = await (await import('../flows/route')).POST(post('/api/flows', { name: 'Sneaky Flow' }))
    installTestAuth(seeded.auth)
    // 401 in production; 500 here when Supabase env is entirely absent and
    // the auth client itself throws. Either way: rejected, nothing written.
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`)
    assert.equal(await prisma.flow.findFirst({ where: { organizationId, name: 'Sneaky Flow' } }), null)
  })

  test('cron dispatch mines an evidence-gated routine from the ledger', async () => {
    const now = Date.now()
    // Learning-period anchor: first event 30 days back.
    await prisma.userEvent.create({
      data: { organizationId, userId, kind: 'assistant_prompt', resourceType: null, resourceId: null, context: {}, occurredAt: new Date(now - 30 * DAY) },
    })
    // A real routine: same agent, same weekday (7-day steps), three weeks.
    for (const daysBack of [21, 14, 7]) {
      await prisma.userEvent.create({
        data: {
          organizationId, userId, kind: 'agent_run_manual', resourceType: 'agent', resourceId: ROUTINE_AGENT,
          context: { name: 'Routine agent' }, occurredAt: new Date(now - daysBack * DAY),
        },
      })
    }

    const res = await (await import('../cron/dispatch/route')).GET(cronReq('/api/cron/dispatch', process.env.CRON_SECRET))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.behaviorOrgsChecked >= 1, `behaviorOrgsChecked=${body.behaviorOrgsChecked}`)

    // Inference is fired void — poll the pattern table for the mined routine.
    const weekday = new Date(now - 7 * DAY).getUTCDay()
    const slug = `routine:agent_run_manual:agent:${ROUTINE_AGENT}:${weekday}`
    const pattern: any = await waitFor(() => prisma.userPattern.findFirst({ where: { organizationId, userId, slug } }))
    assert.ok(pattern, `mined pattern ${slug} not found`)
    assert.equal(pattern.occurrenceCount, 3)
    assert.equal(pattern.status, 'open')
    assert.ok(Array.isArray(pattern.evidence) && (pattern.evidence as string[]).length === 3)

    // Synthesis had no LLM key: it must fail QUIETLY — no suggestion row, and
    // the weekly claim released so a healthy day can retry.
    const open = await prisma.userSuggestion.findFirst({ where: { organizationId, userId } })
    assert.equal(open, null, 'no suggestion should exist without an LLM')
    const user = await waitFor(async () => {
      const row = await prisma.user.findUnique({ where: { id: userId }, select: { metadata: true } })
      return row && !(row.metadata as any)?.lastBehaviorSynthesisAt ? row : null
    })
    assert.ok(user, 'weekly synthesis claim was not released after LLM failure')
  })

  test('surface: GET /api/intelligence/user-suggestions is quiet with no suggestion', async () => {
    const res = await (await import('../intelligence/user-suggestions/route')).GET(req('/api/intelligence/user-suggestions'))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).suggestion, null)
  })

  test('probe: cron endpoints reject a missing/wrong bearer', async () => {
    const dispatch = await (await import('../cron/dispatch/route')).GET(cronReq('/api/cron/dispatch'))
    assert.equal(dispatch.status, 401)
    const retention = await (await import('../cron/retention/route')).GET(cronReq('/api/cron/retention', 'wrong-secret'))
    assert.equal(retention.status, 401)
  })

  test('suggestion surface: accept marks accepted and captures suggestion_accepted', async () => {
    const draft = await prisma.flow.create({ data: { name: 'QA Draft', organizationId, userId, status: 'DRAFT', metadata: { suggested: true, suggestedForUserId: userId } } })
    const suggestion = await prisma.userSuggestion.create({
      data: {
        organizationId, userId, kind: 'new_flow', title: 'Automate the Monday routine', description: 'd',
        flowId: draft.id, sourcePatternSlugs: [], evidence: ['Routine observed 3 times'],
      },
    })
    const routeModule = await import('../intelligence/user-suggestions/route')
    const got = await routeModule.GET(req('/api/intelligence/user-suggestions'))
    const payload = (await got.json()).suggestion
    assert.equal(payload.id, suggestion.id)
    assert.deepEqual(payload.evidence, ['Routine observed 3 times'])

    const res = await routeModule.POST(post('/api/intelligence/user-suggestions', { id: suggestion.id, action: 'accept' }))
    assert.equal(res.status, 200)
    const updated = await prisma.userSuggestion.findFirst({ where: { id: suggestion.id, organizationId } })
    assert.equal(updated.status, 'accepted')
    assert.ok(await findEvent('suggestion_accepted', suggestion.id))
    // Accepted drafts survive.
    assert.ok(await prisma.flow.findFirst({ where: { id: draft.id, organizationId } }))
  })

  test('suggestion surface: dismiss suppresses source patterns and deletes the draft', async () => {
    const weekday = new Date(Date.now() - 7 * DAY).getUTCDay()
    const slug = `routine:agent_run_manual:agent:${ROUTINE_AGENT}:${weekday}`
    const draft = await prisma.flow.create({ data: { name: 'QA Draft 2', organizationId, userId, status: 'DRAFT', metadata: { suggested: true } } })
    const suggestion = await prisma.userSuggestion.create({
      data: {
        organizationId, userId, kind: 'new_flow', title: 'Second idea', description: 'd',
        flowId: draft.id, sourcePatternSlugs: [slug], evidence: [],
      },
    })
    const routeModule = await import('../intelligence/user-suggestions/route')
    const res = await routeModule.POST(post('/api/intelligence/user-suggestions', { id: suggestion.id, action: 'dismiss' }))
    assert.equal(res.status, 200)
    const pattern = await prisma.userPattern.findFirst({ where: { organizationId, userId, slug } })
    assert.equal(pattern.status, 'dismissed', 'source pattern not suppressed')
    assert.equal(await prisma.flow.findFirst({ where: { id: draft.id, organizationId } }), null, 'dismissed draft not deleted')
    assert.ok(await findEvent('suggestion_dismissed', suggestion.id))

    // Probe: acting on it twice is a clean 404, not a double-write.
    const again = await routeModule.POST(post('/api/intelligence/user-suggestions', { id: suggestion.id, action: 'dismiss' }))
    assert.equal(again.status, 404)
  })

  test('retention prunes only ledger rows past the window', async () => {
    const old = await prisma.userEvent.create({
      data: { organizationId, userId, kind: 'flow_created', resourceType: 'flow', resourceId: 'ancient', context: {}, occurredAt: new Date(Date.now() - 200 * DAY) },
    })
    const res = await (await import('../cron/retention/route')).GET(cronReq('/api/cron/retention', process.env.CRON_SECRET))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.userEventsDeleted >= 1, `userEventsDeleted=${body.userEventsDeleted}`)
    assert.equal(await prisma.userEvent.findFirst({ where: { id: old.id, organizationId } }), null, 'old row survived retention')
    assert.ok(await findEvent('agent_created', agentId), 'recent rows must survive retention')
  })
} else {
  test('behavior e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
