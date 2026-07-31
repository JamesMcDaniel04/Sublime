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
export const maxDuration = 1200

// External webhook trigger for flows. Authenticated by the per-flow secret
// (hash stored in flow.trigger.webhookSecretHash) instead of a session — mirrors
// the agent trigger endpoint. Runs the PUBLISHED graph.
function requestHeaders(request: NextRequest): Record<string, string> {
  return Object.fromEntries(Array.from(request.headers.entries()).map(([key, value]) => [key, /^(authorization|x-trigger-secret)$/i.test(key) ? 'redacted' : value]))
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
    const testMode = request.nextUrl.searchParams.get('mode') === 'test'
    const flow = id ? await systemPrisma.flow.findFirst({ where: { id, ...(testMode ? {} : { status: 'ACTIVE' }) } }) : null
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
    const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text().catch(() => '')
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
      if (response.bodyMode === 'none') return new NextResponse(null, { status: response.statusCode, headers: response.headers })
      if (response.bodyMode === 'binary') return new NextResponse(Buffer.from(String(response.body ?? ''), 'base64'), { status: response.statusCode, headers: response.headers })
      if (response.bodyMode === 'text') return new NextResponse(String(response.body ?? ''), { status: response.statusCode, headers: response.headers })
      return NextResponse.json(response.body ?? null, { status: response.statusCode, headers: response.headers })
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
