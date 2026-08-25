/**
 * A real flow run resolving a real external secret must leave NO trace of it
 * in anything persisted — including the FAILURE path.
 *
 * This exists at the integration level on purpose. The unit test that already
 * covered "an error message is scrubbed" tested the redaction helper directly,
 * so it passed while the actual persistence path leaked: `runError` is built
 * as a plain string and written straight to the run row, never passing through
 * the jsonValue chokepoint where scrubbing happens. Testing the helper proved
 * the helper worked; it proved nothing about the path.
 *
 * An error message is one of the LIKELIEST places for a secret to surface —
 * HTTP clients routinely put the failing request, headers included, into the
 * message they throw.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // A loopback store, which is the one case plaintext is permitted.
  process.env.SECRETS_PROVIDER_VAULT_KIND = 'vault'
  process.env.SECRETS_PROVIDER_VAULT_BASE_URL = 'http://127.0.0.1:9999'
  process.env.SECRETS_PROVIDER_VAULT_TOKEN = 'test-vault-token'

  const SECRET = 'sk-live-EXTERNAL-SECRET-NEVER-PERSIST'
  let prisma: typeof import('@/lib/prisma').prisma
  let dispatchFlowExecution: typeof import('../execute-flow').dispatchFlowExecution
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let flowId: string
  let realFetch: typeof globalThis.fetch
  let sentHeader = ''

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ dispatchFlowExecution } = await import('../execute-flow'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)

    const flow = await prisma.flow.create({
      data: {
        name: 'External secret leak',
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
                // A JSON string, as the node schema defines it.
                headers: JSON.stringify({ 'x-api-key': '{{secrets.vault.kv/data/test}}' }),
              },
            },
          ],
          edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
        },
      },
      select: { id: true },
    })
    flowId = flow.id

    realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      // The secret store.
      if (url.includes('127.0.0.1:9999')) {
        return new Response(JSON.stringify({ data: { data: { test: SECRET } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }

      // The API call fails the way a real client fails: with the outbound
      // request — headers and all — in the error message.
      const headers = new Headers(init?.headers ?? {})
      sentHeader = headers.get('x-api-key') ?? ''
      throw new Error(`connect ECONNREFUSED; request headers were x-api-key: ${sentHeader}`)
    }) as typeof globalThis.fetch
  })

  after(async () => {
    if (realFetch) globalThis.fetch = realFetch
    if (seeded) await seeded.cleanup()
    delete process.env.SECRETS_PROVIDER_VAULT_KIND
    delete process.env.SECRETS_PROVIDER_VAULT_BASE_URL
    delete process.env.SECRETS_PROVIDER_VAULT_TOKEN
  })

  test('the secret is resolved and actually reaches the step', async () => {
    await dispatchFlowExecution({
      flowId,
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      input: {},
      trigger: { type: 'manual' },
    } as never)
    // If this fails the rest proves nothing — a secret that never resolved is
    // trivially absent from the run row.
    assert.equal(sentHeader, SECRET, 'the external secret never reached the HTTP step')
  })

  test('the failed run row contains no trace of the secret', async () => {
    const runs = await prisma.flowRun.findMany({
      where: { flowId, organizationId: seeded.organizationId },
      include: { steps: true },
    })
    assert.ok(runs.length >= 1, 'no run was persisted')

    const serialized = JSON.stringify(runs)
    if (serialized.includes(SECRET)) {
      // Name the exact field, so a failure says WHERE rather than just that.
      const where: string[] = []
      for (const run of runs) {
        for (const [field, value] of Object.entries(run)) {
          if (JSON.stringify(value ?? null).includes(SECRET)) where.push(`flowRun.${field}`)
        }
        for (const step of (run as { steps?: Record<string, unknown>[] }).steps ?? []) {
          for (const [field, value] of Object.entries(step)) {
            if (JSON.stringify(value ?? null).includes(SECRET)) where.push(`step[${String(step.nodeId)}].${field}`)
          }
        }
      }
      assert.fail(`the external secret leaked into: ${where.join(', ')}`)
    }
  })

  test('the run still records WHY it failed', async () => {
    const run = await prisma.flowRun.findFirstOrThrow({
      where: { flowId, organizationId: seeded.organizationId },
      orderBy: { startedAt: 'desc' },
    })
    // Redaction must not turn the failure into a mystery: the message stays,
    // only the secret inside it is replaced.
    assert.ok(run.error, 'the run failed without recording an error')
    assert.match(run.error ?? '', /ECONNREFUSED|failed/i)
  })
}
