/**
 * Route-level e2e for the highest-traffic flow entrypoints, following the
 * route-smoke protocol: real Postgres (TEST_DATABASE_URL), seeded auth
 * context, REAL route handlers driven with NextRequest objects, no mocking.
 *
 * Covers:
 *  - /api/flows/[id]/trigger        — public webhook: token auth (header /
 *    none modes), method gating, publish gating, billing 402, rate limit 429
 *  - /api/flows/[id]/execute        — authenticated manual run entrypoint
 *  - /api/flows/[id]/trigger-secret — mint / idempotent re-read / rotate
 *
 * LLM-dependent legs (agent node without provider keys) assert the graceful
 * degradation — the run row exists and reaches a terminal status — never the
 * LLM output itself.
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // trigger-secret stores an AES ciphertext alongside the hash; any non-empty
  // key keeps the QA env off the plaintext b64 fallback.
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'qa-test-key'

  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string

  // Deterministic graph — trigger + transform, no LLM, no connections. The
  // trigger node carries NO data.trigger so publish preserves Flow.trigger
  // as-is (triggerFromGraph falls back to the existing trigger).
  const validGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
  }

  const req = (path: string, init?: RequestInit) => new NextRequest(new URL(`http://test${path}`), init as never)
  const post = (path: string, body: unknown) =>
    req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const triggerReq = (flowId: string, init: { method?: string; headers?: Record<string, string>; body?: string; query?: string } = {}) =>
    req(`/api/flows/${flowId}/trigger${init.query ?? ''}`, {
      method: init.method ?? 'POST',
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    })

  const triggerRoute = () => import('../flows/[id]/trigger/route')
  const executeRoute = () => import('../flows/[id]/execute/route')
  const secretRoute = () => import('../flows/[id]/trigger-secret/route')
  const publishRoute = () => import('../flows/[id]/publish/route')

  const waitFor = async <T>(fn: () => Promise<T | null | undefined>, ms = 15_000): Promise<T | null> => {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  const createFlow = (over: Record<string, unknown> = {}) =>
    prisma.flow.create({
      data: { name: 'Trigger QA', organizationId, userId, trigger: { type: 'webhook' }, graph: validGraph, ...over },
    })

  /** Mint the flow's webhook secret through the real route. */
  const mintSecret = async (flowId: string, rotate = false) => {
    const res = await (await secretRoute()).POST(post(`/api/flows/${flowId}/trigger-secret`, rotate ? { rotate: true } : {}))
    assert.equal(res.status, 200)
    return res.json()
  }

  /** Publish through the real route (single-writer contract). */
  const publish = async (flowId: string) => {
    const res = await (await publishRoute()).POST(post(`/api/flows/${flowId}/publish`, {}))
    assert.equal(res.status, 200, `publish failed: ${await res.clone().text()}`)
  }

  const runsFor = (flowId: string) => prisma.flowRun.findMany({ where: { flowId, organizationId } })
  const terminalRun = (flowRunId: string, orgId = organizationId) =>
    waitFor(async () => {
      const run = await prisma.flowRun.findFirst({ where: { id: flowRunId, organizationId: orgId } })
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null
    })

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

  // ── trigger-secret ────────────────────────────────────────────────────────

  test('trigger-secret: POST mints a secret once; a repeat POST returns hasSecret without the plaintext', async () => {
    const flow = await createFlow({ name: 'Secret Mint QA' })
    const first = await mintSecret(flow.id)
    assert.equal(first.hasSecret, true)
    assert.ok(typeof first.secret === 'string' && first.secret.length > 0, 'plaintext returned exactly once at mint')
    assert.ok(first.url.endsWith(`/api/flows/${flow.id}/trigger`))

    const { hashToken } = await import('@/lib/crypto/secrets')
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal((row.trigger as any).webhookSecretHash, hashToken(first.secret), 'only the SHA-256 hash is stored')
    assert.equal((row.trigger as any).type, 'webhook', 'minting marks the trigger as webhook')

    const second = await mintSecret(flow.id)
    assert.equal(second.hasSecret, true)
    assert.equal(second.secret, null, 'existing secret is never re-revealed without rotate')
    const rowAfter = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal((rowAfter.trigger as any).webhookSecretHash, hashToken(first.secret), 'no silent rotation')
  })

  // ── trigger: header auth mode (the default) ───────────────────────────────

  let headerFlowId: string
  let headerSecret: string

  test('trigger: setup — webhook flow with header auth, published through the real routes', async () => {
    const flow = await createFlow({ name: 'Header Auth QA' })
    headerFlowId = flow.id
    headerSecret = (await mintSecret(flow.id)).secret
    await publish(flow.id)
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId } })
    assert.equal(row.status, 'ACTIVE')
    assert.ok(row.publishedGraph, 'publish must set publishedGraph')
    assert.ok((row.trigger as any).webhookSecretHash, 'publish must preserve the secret hash')
  })

  test('trigger: missing or wrong token is a 401 and dispatches nothing (header mode)', async () => {
    const { POST } = await triggerRoute()
    // No header at all.
    const missing = await POST(triggerReq(headerFlowId))
    assert.equal(missing.status, 401)
    assert.equal((await missing.json()).success, false)
    // Wrong value.
    const wrong = await POST(triggerReq(headerFlowId, { headers: { 'x-trigger-secret': 'not-the-secret' } }))
    assert.equal(wrong.status, 401)
    // Right value in the wrong place (bearer instead of the configured header).
    const misplaced = await POST(triggerReq(headerFlowId, { headers: { authorization: `Bearer ${headerSecret}` } }))
    assert.equal(misplaced.status, 401)

    assert.equal((await runsFor(headerFlowId)).length, 0, 'no FlowRun may exist after rejected attempts')
  })

  test('trigger: the correct secret dispatches the published graph and records an org-scoped FlowRun', async () => {
    const { POST } = await triggerRoute()
    const res = await POST(triggerReq(headerFlowId, {
      headers: { 'x-trigger-secret': headerSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ input: { name: 'qa' } }),
    }))
    assert.ok([200, 202].includes(res.status), `unexpected status ${res.status}`)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.ok(body.run.flowRunId, 'caller gets the run id')

    // Dispatch may be async in queue mode — poll briefly for the terminal row.
    const run = await terminalRun(body.run.flowRunId)
    assert.ok(run, 'FlowRun row must appear, scoped by organizationId')
    assert.equal(run.organizationId, organizationId)
    assert.equal(run.status, 'succeeded', 'deterministic transform graph must succeed')
    assert.equal((run.trigger as any).type, 'webhook', 'provenance persisted on the run')
    assert.equal((run.trigger as any).mode, 'production')
  })

  test('trigger: methods not enabled for the webhook are 405 with an Allow header', async () => {
    // webhookMethods unset defaults to ['POST'] — every other verb is refused
    // even with a valid secret, exercising the GET/PUT/PATCH/DELETE exports.
    const route = await triggerRoute()
    const headers = { 'x-trigger-secret': headerSecret }
    for (const [method, handler] of [['GET', route.GET], ['PUT', route.PUT], ['PATCH', route.PATCH], ['DELETE', route.DELETE]] as const) {
      const res = await handler(triggerReq(headerFlowId, { method, headers }))
      assert.equal(res.status, 405, `${method} must be refused`)
      assert.equal(res.headers.get('allow'), 'POST')
    }
    assert.equal((await runsFor(headerFlowId)).length, 1, 'method refusals dispatch nothing')
  })

  // ── trigger: 'none' auth mode ─────────────────────────────────────────────

  let openFlowId: string

  test("trigger: webhookAuth 'none' dispatches with no credentials at all (by design)", async () => {
    // 'none' is an explicit opt-out: the flow owner chose an unauthenticated
    // webhook (public form posts etc.). The route intentionally skips the
    // secret check entirely — rate limiting is the only protection left.
    const flow = await createFlow({
      name: 'Open Webhook QA',
      trigger: { type: 'webhook', webhookAuth: 'none', webhookMethods: ['POST', 'GET'] },
    })
    openFlowId = flow.id
    await publish(flow.id)

    const { POST, GET } = await triggerRoute()
    const res = await POST(triggerReq(flow.id, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'world' }) }))
    assert.ok([200, 202].includes(res.status), `unexpected status ${res.status}`)
    const body = await res.json()
    assert.equal(body.success, true)
    const run = await terminalRun(body.run.flowRunId)
    assert.ok(run, 'unauthenticated dispatch must create a FlowRun')
    assert.equal(run.status, 'succeeded')

    // An enabled non-POST verb also dispatches (GET is in webhookMethods).
    const got = await GET(triggerReq(flow.id, { method: 'GET', query: '?name=qa' }))
    assert.ok([200, 202].includes(got.status), `unexpected GET status ${got.status}`)
    assert.equal((await got.json()).success, true)
  })

  test('trigger: malformed JSON with a JSON content-type is a 400, not a run', async () => {
    const { POST } = await triggerRoute()
    const before = (await runsFor(openFlowId)).length
    const res = await POST(triggerReq(openFlowId, { headers: { 'content-type': 'application/json' }, body: '{not-json' }))
    assert.equal(res.status, 400)
    assert.equal((await runsFor(openFlowId)).length, before, 'bad payloads dispatch nothing')
  })

  test('trigger: a non-webhook trigger type is a 409 even when auth passes', async () => {
    const flow = await createFlow({ name: 'Manual Trigger QA', trigger: { type: 'manual', webhookAuth: 'none' } })
    const { POST } = await triggerRoute()
    // mode=test so the DRAFT status doesn't hide the flow before the type check.
    const res = await POST(triggerReq(flow.id, { query: '?mode=test' }))
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /not configured for webhook/)
  })

  // ── trigger: publish gating ───────────────────────────────────────────────

  test('trigger: an unpublished flow does not dispatch in non-test mode; mode=test runs the draft', async () => {
    const flow = await createFlow({ name: 'Draft Gate QA' })
    const secret = (await mintSecret(flow.id)).secret
    // NOT published — status stays DRAFT.

    const { POST } = await triggerRoute()
    // Non-test mode: the ACTIVE-only lookup hides the draft, so even the
    // correct secret gets the same 401 as a wrong one (no existence oracle).
    const res = await POST(triggerReq(flow.id, { headers: { 'x-trigger-secret': secret } }))
    assert.equal(res.status, 401)
    assert.equal((await runsFor(flow.id)).length, 0, 'a draft must never dispatch in production mode')

    // mode=test (the builder's test URL) runs the draft graph with the secret.
    const testRes = await POST(triggerReq(flow.id, { query: '?mode=test', headers: { 'x-trigger-secret': secret } }))
    assert.ok([200, 202].includes(testRes.status), `unexpected status ${testRes.status}`)
    const run = await terminalRun((await testRes.json()).run.flowRunId)
    assert.ok(run, 'test mode must dispatch the draft')
    assert.equal((run.trigger as any).mode, 'test')
  })

  test('trigger: ACTIVE flow with no publishedGraph is a 409 (defensive branch), not a run', async () => {
    // Should be impossible post single-writer, but the route defends against
    // it. NOTE: publishedGraph is intentionally OMITTED (SQL NULL) — passing
    // `publishedGraph: null` to Prisma would write JSON null, which is not NULL.
    const flow = await createFlow({
      name: 'Active Unpublished QA',
      status: 'ACTIVE',
      trigger: { type: 'webhook', webhookAuth: 'none' },
    })
    const { POST } = await triggerRoute()
    const res = await POST(triggerReq(flow.id))
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /Publish the flow/)
    assert.equal((await runsFor(flow.id)).length, 0)
  })

  // ── trigger: rotation ─────────────────────────────────────────────────────

  test('trigger-secret: rotate mints a new secret and the old one stops working immediately', async () => {
    const flow = await createFlow({ name: 'Rotation QA' })
    const secret1 = (await mintSecret(flow.id)).secret
    await publish(flow.id)
    const { POST } = await triggerRoute()

    const ok1 = await POST(triggerReq(flow.id, { headers: { 'x-trigger-secret': secret1 } }))
    assert.ok([200, 202].includes(ok1.status), 'pre-rotation secret must work')

    const rotated = await mintSecret(flow.id, true)
    const secret2 = rotated.secret
    assert.ok(secret2 && secret2 !== secret1, 'rotation must mint a NEW plaintext')

    const stale = await POST(triggerReq(flow.id, { headers: { 'x-trigger-secret': secret1 } }))
    assert.equal(stale.status, 401, 'the old secret must be dead the moment rotation lands')
    const fresh = await POST(triggerReq(flow.id, { headers: { 'x-trigger-secret': secret2 } }))
    assert.ok([200, 202].includes(fresh.status), 'the new secret must work')
    const run = await terminalRun((await fresh.json()).run.flowRunId)
    assert.ok(run)
    assert.equal(run.status, 'succeeded')
  })

  // ── trigger: billing + rate limit gates ───────────────────────────────────

  test('trigger: an unpaid org gets an honest 402 before any run row exists', async () => {
    // Org created after the grandfathering cutoff on the legacy TRIAL plan =
    // payment_required. Everything else about the flow is valid and published.
    const org = await prisma.organization.create({ data: { name: 'Unpaid QA', slug: `unpaid-${crypto.randomUUID()}`, plan: 'TRIAL' } })
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
    try {
      const flow = await prisma.flow.create({
        data: { name: 'Unpaid Flow QA', organizationId: org.id, userId: user.id, trigger: { type: 'webhook', webhookAuth: 'none' }, graph: validGraph },
      })
      const { publishFlowDraft } = await import('@/lib/flows/publish')
      const published = await publishFlowDraft(flow.id, org.id, user.id)
      assert.equal(published.published, true)

      const { POST } = await triggerRoute()
      const res = await POST(triggerReq(flow.id))
      assert.equal(res.status, 402)
      assert.match((await res.json()).error, /active plan/)
      assert.equal(await prisma.flowRun.findFirst({ where: { flowId: flow.id, organizationId: org.id } }), null,
        'the billing gate must fire before any run row exists')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('trigger: per-flow rate limit blunts secret-guessing floods with a 429', async () => {
    // Dedicated (nonexistent) flow id so the shared limiter never throttles
    // the other tests. 60/min per flow id; the 61st hit trips the limit
    // BEFORE the flow lookup.
    const floodId = `rl-qa-${crypto.randomUUID()}`
    const { POST } = await triggerRoute()
    for (let i = 0; i < 60; i++) {
      const res = await POST(triggerReq(floodId, { headers: { 'x-trigger-secret': 'guess' } }))
      assert.equal(res.status, 401, `attempt ${i + 1} should still be an auth failure`)
    }
    const throttled = await POST(triggerReq(floodId, { headers: { 'x-trigger-secret': 'guess' } }))
    assert.equal(throttled.status, 429)
  })

  // ── trigger: LLM-dependent leg degrades gracefully ────────────────────────

  test('trigger: an agent-step flow without provider keys still records a terminal FlowRun', async () => {
    const agentRes = await (await import('../agents/route')).POST(post('/api/agents', {
      title: 'Trigger QA Agent', instructions: 'Echo the input.',
    }))
    assert.equal(agentRes.status, 200)
    const agentId = (await agentRes.json()).agent.id
    const flow = await createFlow({
      name: 'Agent Leg QA',
      trigger: { type: 'webhook', webhookAuth: 'none' },
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', data: {} },
          { id: 'a1', type: 'agent', data: { agentId } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
      },
    })
    await publish(flow.id)
    const { POST } = await triggerRoute()
    const res = await POST(triggerReq(flow.id, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi' }) }))
    assert.ok([200, 202].includes(res.status), `unexpected status ${res.status}`)
    const body = await res.json()
    // The degradation contract: the run exists, is org-scoped, and reaches a
    // terminal status (failed without an LLM key, succeeded with one) — no
    // stuck 'running' row, no phantom rows. LLM output is never asserted.
    const run = await terminalRun(body.run.flowRunId)
    assert.ok(run, 'run must terminalize even when the LLM leg fails')
    assert.ok(['failed', 'succeeded'].includes(run.status), `unexpected terminal status ${run.status}`)
    if (run.status === 'failed') assert.ok(run.error, 'a failed run must say why')
  })

  // ── execute ───────────────────────────────────────────────────────────────

  test('execute: unauthenticated request is rejected and dispatches nothing', async () => {
    const { clearTestAuth, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const flow = await createFlow({ name: 'Execute Unauth QA', trigger: { type: 'manual' } })
    clearTestAuth()
    const res = await (await executeRoute()).POST(post(`/api/flows/${flow.id}/execute`, { input: 'nope' }))
    installTestAuth(seeded.auth)
    // 401 in production; 500 here when Supabase env is entirely absent and the
    // auth client itself throws. Either way: rejected, nothing dispatched.
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`)
    assert.equal((await runsFor(flow.id)).length, 0)
  })

  test('execute: authenticated run creates a FlowRun that reaches a terminal status', async () => {
    const flow = await createFlow({ name: 'Execute QA', trigger: { type: 'manual' } })
    const res = await (await executeRoute()).POST(post(`/api/flows/${flow.id}/execute`, { input: { name: 'qa' } }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.ok(body.run.flowRunId, 'caller gets an id to poll')
    // background:true — the route answers 'queued' and the run continues
    // detached, so the terminal status is polled from the DB.
    assert.ok(['queued', 'claimed', 'running', 'succeeded'].includes(body.run.status), `unexpected status ${body.run.status}`)

    const run = await terminalRun(body.run.flowRunId)
    assert.ok(run, 'FlowRun must appear and terminalize, scoped by organizationId')
    assert.equal(run.status, 'succeeded')
    assert.equal(run.userId, userId, 'the run is attributed to the caller')
    assert.equal((run.trigger as any).type, 'manual')
  })

  test('execute: unknown flow id is a 404; flowRunId without a reply is a 400', async () => {
    const route = await executeRoute()
    const missing = await route.POST(post(`/api/flows/flow_${crypto.randomUUID()}/execute`, {}))
    assert.equal(missing.status, 404)

    const flow = await createFlow({ name: 'Execute Guard QA', trigger: { type: 'manual' } })
    const badResume = await route.POST(post(`/api/flows/${flow.id}/execute`, { flowRunId: 'run_whatever' }))
    assert.equal(badResume.status, 400)
    assert.equal((await badResume.json()).code, 'FLOW_RESUME_REQUIRES_REPLY')
  })
} else {
  test('flow trigger/execute e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
