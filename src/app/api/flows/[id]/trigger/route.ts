import { NextRequest, NextResponse } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution, runFlowExecution } from '@/features/flows/execute-flow'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { ApiError } from '@/lib/server/api-handler'
import { assertOrganizationBillingActive } from '@/lib/billing/enforce'

export const runtime = 'nodejs'
// 800 is Vercel's actual Pro-plan (fluid) ceiling — 1200 was silently clamped,
// so internal budgets sized against it overran the real limit and died with
// no clean error.
export const maxDuration = 800

// External webhook trigger for flows. Authenticated by the per-flow secret
// (hash stored in flow.trigger.webhookSecretHash) instead of a session — mirrors
// the agent trigger endpoint. Runs the PUBLISHED graph.
function requestHeaders(request: NextRequest): Record<string, string> {
  return Object.fromEntries(Array.from(request.headers.entries()).map(([key, value]) => [key, /^(authorization|x-trigger-secret)$/i.test(key) ? 'redacted' : value]))
}

/**
 * Largest webhook body accepted. Without a cap, `request.text()` buffers
 * whatever the caller sends into worker memory before any validation runs —
 * a secret holder (or a misconfigured upstream) could push hundreds of
 * megabytes per request. 1 MiB comfortably covers real webhook payloads.
 */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576

class PayloadTooLargeError extends Error {}

/**
 * Read the body, refusing anything over the cap. Content-Length is checked
 * first (cheap rejection) but is caller-supplied and may be absent under
 * chunked encoding, so the stream is also counted as it arrives and aborted
 * the moment it crosses the limit.
 */
async function readBodyWithLimit(request: NextRequest): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError()

  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError()
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/**
 * Harden a Respond-to-webhook response.
 *
 * The body is author-templated and routinely echoes request data, and this
 * endpoint lives on the APP's own origin — so an author who sets
 * `content-type: text/html` turns their webhook into a same-origin HTML sink
 * fed by whatever the caller sent. These headers make the response inert
 * whatever content type is chosen: `sandbox` with no allow-* tokens blocks
 * script execution, form submission, and same-origin inheritance, and nosniff
 * stops a mislabelled body being sniffed into HTML. Applied AFTER the author's
 * headers so they cannot be weakened from the graph.
 */
function inertResponseHeaders(authorHeaders: Record<string, string>): Record<string, string> {
  return {
    ...authorHeaders,
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
  }
}

function queryParams(request: NextRequest): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {}
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const values = request.nextUrl.searchParams.getAll(key)
    output[key] = values.length > 1 ? values : values[0] ?? ''
  }
  return output
}

async function handle(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per flow id to blunt secret-guessing floods.
    const limited = await rateLimit(`flow-trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000 })
    if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

    // systemPrisma: session-less webhook trigger (per-flow secret, no org context); flow id is globally unique.
    // mode=test exists for the pre-publish workflow: point a real upstream at a
    // DRAFT flow and iterate on the graph. It is NOT a general publish-gate
    // escape — a DRAFT flow is the only status where running the draft graph
    // bypasses nothing, because there is no published graph and no third party
    // yet depending on reviewed behaviour. Allowing it for any status let a
    // secret holder run unreviewed draft edits of a live flow, and resurrect a
    // flow its owner had deliberately DISABLED. Post-publish testing belongs on
    // the authenticated in-app paths (/execute, /test-node).
    const testMode = request.nextUrl.searchParams.get('mode') === 'test'
    const flow = id ? await systemPrisma.flow.findFirst({ where: { id, ...(testMode ? { status: 'DRAFT' } : { status: 'ACTIVE' }) } }) : null
    const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null
    const authMode = ['none', 'header', 'bearer', 'basic'].includes(String(trigger.webhookAuth)) ? String(trigger.webhookAuth) : 'header'
    const authorization = request.headers.get('authorization') || ''
    let provided = ''
    if (authMode === 'header') provided = request.headers.get(typeof trigger.webhookHeaderName === 'string' ? trigger.webhookHeaderName : 'x-trigger-secret') || ''
    else if (authMode === 'bearer') provided = authorization.replace(/^Bearer\s+/i, '')
    else if (authMode === 'basic') {
      try {
        const [username, password = ''] = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8').split(':')
        if (!trigger.webhookUsername || username === trigger.webhookUsername) provided = password
      } catch { provided = '' }
    }
    if (!flow || (authMode !== 'none' && (!hash || !provided || !timingSafeEqualHex(hashToken(provided), hash)))) {
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }
    if (trigger.type !== 'webhook') {
      return NextResponse.json({ success: false, error: 'This flow is not configured for webhook triggering.' }, { status: 409 })
    }
    if (!testMode && flow.publishedGraph == null) {
      return NextResponse.json({ success: false, error: 'Publish the flow before triggering it externally.' }, { status: 409 })
    }
    const allowedMethods = Array.isArray(trigger.webhookMethods) ? trigger.webhookMethods.map(String) : ['POST']
    if (!allowedMethods.includes(request.method)) {
      return NextResponse.json({ success: false, error: `Method ${request.method} is not enabled for this webhook.` }, { status: 405, headers: { Allow: allowedMethods.join(', ') } })
    }

    // Billing gate before any run row exists: external callers get an honest
    // 402 (also covers the runFlowExecution fast-path, which bypasses the
    // dispatchFlowExecution choke point).
    try {
      await assertOrganizationBillingActive(flow.organizationId)
    } catch {
      return NextResponse.json(
        { success: false, error: 'This workspace needs an active plan before flows can run.' },
        { status: 402 },
      )
    }

    // The run is attributed to the flow's owner (or the org's oldest member).
    const owner = flow.userId
      ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
      : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
    if (!owner) return NextResponse.json({ success: false, error: 'No active user to attribute the run to' }, { status: 409 })

    const contentType = request.headers.get('content-type') || ''
    let rawBody = ''
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try {
        rawBody = await readBodyWithLimit(request)
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          return NextResponse.json(
            { success: false, error: `Request body exceeds the ${MAX_WEBHOOK_BODY_BYTES / 1024}KB webhook limit.` },
            { status: 413 },
          )
        }
        rawBody = ''
      }
    }
    let body: unknown = rawBody
    if (contentType.toLowerCase().includes('application/json') && rawBody) {
      try { body = JSON.parse(rawBody) } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }
    }
    const bodyInput = flowInputFromWebhookBody(body)
    const input = trigger.webhookPayload === 'request'
      ? { body: bodyInput, rawBody, query: queryParams(request), headers: requestHeaders(request), method: request.method, url: request.nextUrl.toString() }
      : bodyInput
    // Queue mode: the webhook caller gets the run id immediately (202,
    // status 'queued') and the run executes on the worker; inline returns
    // the terminal result as before.
    const executionJob = {
      flowId: flow.id,
      organizationId: flow.organizationId,
      userId: owner.id,
      input,
      usePublished: !testMode,
      trigger: { type: 'webhook' as const, mode: testMode ? 'test' : 'production' },
    }
    // A caller waiting for the last step or Respond-to-webhook node needs the
    // terminal value on this same HTTP connection. Immediate/receipt mode
    // keeps normal queued execution throughput.
    const result = trigger.webhookResponse === 'lastNode' || trigger.webhookResponse === 'respondNode'
      ? await runFlowExecution(executionJob)
      : await dispatchFlowExecution(executionJob)
    const run = 'queued' in result ? { flowRunId: result.flowRunId, status: 'queued', output: null } : result
    if (!('queued' in result) && trigger.webhookResponse === 'respondNode' && result.webhookResponse) {
      const response = result.webhookResponse
      const headers = inertResponseHeaders(response.headers)
      if (response.bodyMode === 'none') return new NextResponse(null, { status: response.statusCode, headers })
      if (response.bodyMode === 'binary') return new NextResponse(Buffer.from(String(response.body ?? ''), 'base64'), { status: response.statusCode, headers })
      if (response.bodyMode === 'text') return new NextResponse(String(response.body ?? ''), { status: response.statusCode, headers })
      return NextResponse.json(response.body ?? null, { status: response.statusCode, headers })
    }
    if (!('queued' in result) && trigger.webhookResponse === 'lastNode') return NextResponse.json(result.output ?? null)
    return NextResponse.json({ success: true, run }, { status: 'queued' in result ? 202 : 200 })
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status })
    }
    apiLogger.error('flow trigger failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const HEAD = handle
export const OPTIONS = handle
