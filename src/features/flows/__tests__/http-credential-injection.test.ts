/**
 * End-to-end credential injection: a real flow run whose HTTP step references a
 * vault credential must (a) put the credential on the wire, and (b) leave NO
 * trace of it in the persisted run row.
 *
 * (b) is the reason this test exists at the integration level rather than as a
 * unit test of applyCredentialPlan — the secret passes through prepareHttpRequest,
 * the fetch, and the FlowRunStep write, and any one of those could persist it.
 */
import type { Prisma } from '@/generated/prisma/client'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key'

  const SECRET = 'sk-live-NEVER-PERSIST-ME'
  let prisma: typeof import('@/lib/prisma').prisma
  let dispatchFlowExecution: typeof import('../execute-flow').dispatchFlowExecution
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let flowId: string
  let credentialId: string
  const seenAuth: string[] = []
  const seenUrls: string[] = []
  let realFetch: typeof globalThis.fetch

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ dispatchFlowExecution } = await import('../execute-flow'))
    const { buildCredentialConfig } = await import('@/lib/credentials/config')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)

    const cred = await prisma.credential.create({
      data: {
        organizationId: seeded.organizationId,
        // Both fields are load-bearing under the fail-closed credential policy:
        // an ownerless (NULL userId) row can never resolve — credentialScope
        // substitutes an actor-required sentinel rather than falling back to
        // legacy shared rows — and an empty allow-list denies every URL. A
        // fixture missing either resolves to CREDENTIAL_UNAVAILABLE, which
        // would mask what these tests actually assert.
        userId: seeded.userId,
        allowedDomains: ['example.com'],
        name: 'E2E bearer',
        type: 'bearer',
        authConfig: buildCredentialConfig({ type: 'bearer', token: SECRET }) as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    credentialId = cred.id

    const flow = await prisma.flow.create({
      data: {
        name: 'Credential injection',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        trigger: { type: 'manual' },
        graph: {
          nodes: [
            { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
            {
              id: 'call',
              type: 'http',
              data: {
                label: 'Call API',
                method: 'GET',
                url: 'https://example.com/v1/things',
                authMode: 'generic',
                credentialId: cred.id,
              },
            },
          ],
          edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
        },
      },
      select: { id: true },
    })
    flowId = flow.id

    // Stub the wire, capturing what the credential actually produced.
    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      seenUrls.push(url)
      const headers = new Headers(init?.headers ?? {})
      seenAuth.push(headers.get('authorization') ?? '')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
  })

  after(async () => {
    if (realFetch) globalThis.fetch = realFetch
    if (seeded) await seeded.cleanup()
  })

  test('the outbound request carries the credential', async () => {
    const result = await dispatchFlowExecution({
      flowId,
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      input: {},
      trigger: { type: 'manual' },
    })
    assert.ok(!('queued' in result), 'expected an inline run')
    // Surface the run's own error — a silent "fetch never called" tells you
    // nothing about which guard rejected the step.
    assert.equal(seenAuth.length >= 1, true, `the HTTP step never called fetch (run: ${JSON.stringify(result)})`)
    assert.equal(seenAuth[0], `Bearer ${SECRET}`)
  })

  test('the persisted run row contains NO trace of the secret', async () => {
    const runs = await prisma.flowRun.findMany({
      where: { flowId, organizationId: seeded.organizationId },
      include: { steps: true },
    })
    assert.ok(runs.length >= 1, 'no run was persisted')
    const serialized = JSON.stringify(runs)
    assert.equal(serialized.includes(SECRET), false, 'the secret leaked into the run row')
    // The step itself still recorded, so the run stays debuggable.
    assert.ok(runs[0].steps.some((step: { nodeId: string }) => step.nodeId === 'call'))
  })

  test('the graph never stored the secret — only the opaque id', async () => {
    const flow = await prisma.flow.findFirstOrThrow({
      where: { id: flowId, organizationId: seeded.organizationId },
      select: { graph: true },
    })
    const serialized = JSON.stringify(flow.graph)
    assert.equal(serialized.includes(SECRET), false)
    assert.equal(serialized.includes(credentialId), true, 'the credential reference should travel')
  })

  test('a domain-blocked credential fails the step instead of sending the secret', async () => {
    await prisma.credential.updateMany({
      where: { id: credentialId, organizationId: seeded.organizationId },
      data: { allowedDomains: ['other.test'] },
    })
    const before = seenAuth.length
    const result = await dispatchFlowExecution({
      flowId,
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      input: {},
      trigger: { type: 'manual' },
    })
    const status = 'queued' in result ? 'queued' : result.status
    assert.notEqual(status, 'succeeded')
    // Prove the CREDENTIAL's allow-list rejected it, not some earlier guard —
    // an SSRF/DNS rejection would satisfy "never reached the wire" while
    // testing nothing about the allow-list.
    const error = 'queued' in result ? '' : String(result.error ?? '')
    assert.match(error, /not allowed for that request URL/i)
    assert.equal(seenAuth.length, before, 'a blocked credential must not reach the wire at all')
  })
}
