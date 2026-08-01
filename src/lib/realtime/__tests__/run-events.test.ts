/**
 * Coverage for the server-side run-event broadcast (src/lib/realtime/run-events.ts).
 *
 * The design claim under test: "a lost broadcast costs latency, never
 * correctness — polling is the fallback." Concretely that means the helper is
 * a silent no-op without Supabase env, and with env set it is strictly
 * fire-and-forget: no fetch failure, timeout, or non-ok response may ever
 * propagate to (or block) the caller.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/realtime/__tests__/run-events.test.ts
 */
import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { broadcastRunEvent, runEventsConfigured, runEventsTopic, type RunEvent } from '../run-events'
import { apiLogger } from '../../logger'

const ORIGINAL_ENV = { ...process.env }
const realFetch = globalThis.fetch

const SUPABASE_URL = 'https://proj.supabase.co'
const SERVICE_KEY = 'service-role-key'
const ORG_ID = 'org_123'
const EVENT: RunEvent = { kind: 'flow', runId: 'run_1', status: 'COMPLETED', flowId: 'flow_1' }

type CapturedCall = { input: RequestInfo | URL; init: RequestInit | undefined }

/** Stub globalThis.fetch; returns the captured calls plus a promise that resolves once fetch has been invoked. */
function stubFetch(respond: () => Promise<Response>) {
  const calls: CapturedCall[] = []
  let signalInvoked!: () => void
  const invoked = new Promise<void>((resolve) => {
    signalInvoked = resolve
  })
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    signalInvoked()
    return respond()
  }) as typeof fetch
  return { calls, invoked }
}

/** Let the fire-and-forget .then/.catch chain (and unhandled-rejection detection) run. */
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** Collect unhandled rejections raised while `run` executes. */
async function withUnhandledRejectionTracking(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  try {
    await run()
    await flushAsync()
  } finally {
    process.off('unhandledRejection', listener)
  }
  return unhandled
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  globalThis.fetch = realFetch
  mock.restoreAll()
})

function setSupabaseEnv(url: string = SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
}

// ---------------------------------------------------------------------------
// (1) No Supabase env: silent no-op.
// ---------------------------------------------------------------------------

test('no SUPABASE env: broadcast is a silent no-op — no fetch, no throw, no unhandled rejection', async () => {
  const { calls } = stubFetch(() => Promise.reject(new Error('must never be called')))
  const unhandled = await withUnhandledRejectionTracking(async () => {
    assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))
  })
  assert.equal(calls.length, 0, 'fetch must not be called without Supabase env')
  assert.deepEqual(unhandled, [])
})

test('partial env (URL without service key, and vice versa) is also a no-op', () => {
  const { calls } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))

  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
  assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))

  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// (2) Env set: POST to the Realtime broadcast endpoint with the expected shape.
// ---------------------------------------------------------------------------

test('with env set: POSTs to <url>/realtime/v1/api/broadcast with service-role auth, run-scoped topic, and payload', async () => {
  setSupabaseEnv()
  const { calls, invoked } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  broadcastRunEvent(ORG_ID, EVENT)
  await invoked

  assert.equal(calls.length, 1)
  const { input, init } = calls[0]
  assert.equal(String(input), `${SUPABASE_URL}/realtime/v1/api/broadcast`)
  assert.equal(init?.method, 'POST')

  const headers = init?.headers as Record<string, string>
  assert.equal(headers.apikey, SERVICE_KEY)
  assert.equal(headers.Authorization, `Bearer ${SERVICE_KEY}`)
  assert.equal(headers['Content-Type'], 'application/json')

  const body = JSON.parse(String(init?.body))
  assert.deepEqual(body, {
    messages: [
      {
        topic: `run-events:${ORG_ID}`,
        event: 'run',
        private: true,
        payload: { kind: 'flow', runId: 'run_1', status: 'COMPLETED', flowId: 'flow_1' },
      },
    ],
  })
  await flushAsync()
})

test('trailing slash on NEXT_PUBLIC_SUPABASE_URL is normalized (no double slash in endpoint)', async () => {
  setSupabaseEnv(`${SUPABASE_URL}/`)
  const { calls, invoked } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  broadcastRunEvent(ORG_ID, EVENT)
  await invoked

  assert.equal(String(calls[0].input), `${SUPABASE_URL}/realtime/v1/api/broadcast`)
  await flushAsync()
})

test('request carries an AbortSignal (the 3s fire-and-forget bound)', async () => {
  setSupabaseEnv()
  const { calls, invoked } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  broadcastRunEvent(ORG_ID, EVENT)
  await invoked

  const signal = calls[0].init?.signal
  assert.ok(signal instanceof AbortSignal, 'expected an AbortSignal on the request')
  assert.equal(signal.aborted, false)
  await flushAsync()
})

// ---------------------------------------------------------------------------
// (3) Failures NEVER propagate to the caller.
// ---------------------------------------------------------------------------

test('fetch network failure never propagates: no throw, no unhandled rejection, warn logged', async () => {
  setSupabaseEnv()
  const warn = mock.method(apiLogger, 'warn', () => {})
  stubFetch(() => Promise.reject(new Error('ECONNREFUSED')))

  const unhandled = await withUnhandledRejectionTracking(async () => {
    assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))
  })

  assert.deepEqual(unhandled, [], 'a broadcast failure must never surface as an unhandled rejection')
  assert.equal(warn.mock.callCount(), 1)
  const [message, meta] = warn.mock.calls[0].arguments as [string, Record<string, unknown>]
  assert.match(message, /broadcast failed/)
  assert.equal(meta.organizationId, ORG_ID)
  assert.equal(meta.error, 'ECONNREFUSED')
})

test('timeout-style abort (TimeoutError) never propagates', async () => {
  setSupabaseEnv()
  const warn = mock.method(apiLogger, 'warn', () => {})
  stubFetch(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))

  const unhandled = await withUnhandledRejectionTracking(async () => {
    assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))
  })

  assert.deepEqual(unhandled, [])
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /broadcast failed/)
})

test('non-Error rejection (e.g. a string) never propagates and is stringified in the warn', async () => {
  setSupabaseEnv()
  const warn = mock.method(apiLogger, 'warn', () => {})
  stubFetch(() => Promise.reject('socket hang up'))

  const unhandled = await withUnhandledRejectionTracking(async () => {
    assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))
  })

  assert.deepEqual(unhandled, [])
  assert.equal(warn.mock.callCount(), 1)
  const meta = warn.mock.calls[0].arguments[1] as Record<string, unknown>
  assert.equal(meta.error, 'socket hang up')
})

test('non-ok response (broadcast rejected by Realtime) never throws; warn carries the status', async () => {
  setSupabaseEnv()
  const warn = mock.method(apiLogger, 'warn', () => {})
  stubFetch(() => Promise.resolve(new Response(null, { status: 403 })))

  const unhandled = await withUnhandledRejectionTracking(async () => {
    assert.doesNotThrow(() => broadcastRunEvent(ORG_ID, EVENT))
  })

  assert.deepEqual(unhandled, [])
  assert.equal(warn.mock.callCount(), 1)
  const [message, meta] = warn.mock.calls[0].arguments as [string, Record<string, unknown>]
  assert.match(message, /broadcast rejected/)
  assert.equal(meta.status, 403)
  assert.equal(meta.organizationId, ORG_ID)
})

test('successful delivery logs nothing', async () => {
  setSupabaseEnv()
  const warn = mock.method(apiLogger, 'warn', () => {})
  const { invoked } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  broadcastRunEvent(ORG_ID, EVENT)
  await invoked
  await flushAsync()

  assert.equal(warn.mock.callCount(), 0)
})

// ---------------------------------------------------------------------------
// (4) runEventsConfigured reflects env presence. NOTE: this export currently
// has zero callers in the codebase (dead export) — covered here regardless.
// ---------------------------------------------------------------------------

test('runEventsConfigured: false with no env, false with partial env, true with both', () => {
  assert.equal(runEventsConfigured(), false)

  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
  assert.equal(runEventsConfigured(), false)

  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
  assert.equal(runEventsConfigured(), true)

  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  assert.equal(runEventsConfigured(), false)
})

// ---------------------------------------------------------------------------
// (5) Topic naming matches what the RLS migration parses.
// prisma/migrations/20260731180000_run_events_private_realtime/migration.sql:
// can_access_run_events checks split_part(topic, ':', 1) = 'run-events' and
// compares split_part(topic, ':', 2) to the member's organizationId.
// ---------------------------------------------------------------------------

test('runEventsTopic produces run-events:<organizationId>, parseable exactly as the RLS function expects', () => {
  const organizationId = 'cmb1x2y3z0000abcd1234'
  const topic = runEventsTopic(organizationId)
  assert.equal(topic, `run-events:${organizationId}`)

  // Mirror Postgres split_part(topic, ':', n) semantics.
  const parts = topic.split(':')
  assert.equal(parts[0], 'run-events', 'split_part(topic, \':\', 1) must equal run-events')
  assert.equal(parts[1], organizationId, 'split_part(topic, \':\', 2) must be the raw organizationId')
  assert.equal(parts.length, 2, 'organizationId must not introduce extra colon segments')
})

test('broadcast body topic and the client subscription topic agree (run-events:<orgId>)', async () => {
  // use-run-events.ts subscribes with supabase.channel(`run-events:${organizationId}`).
  setSupabaseEnv()
  const { calls, invoked } = stubFetch(() => Promise.resolve(new Response(null, { status: 202 })))

  broadcastRunEvent(ORG_ID, EVENT)
  await invoked

  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.messages[0].topic, runEventsTopic(ORG_ID))
  assert.equal(body.messages[0].topic, `run-events:${ORG_ID}`)
  await flushAsync()
})
