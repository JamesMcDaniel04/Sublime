import { NextResponse, type NextRequest } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { flowGraphSchema } from '@/lib/flows/graph'
import { formFieldsFor, coerceFormSubmission } from '@/lib/flows/form-trigger'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { webhookAuthFailureEvent, webhookThrottled } from '@/lib/server/webhook-guard'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The public form endpoint — how someone OUTSIDE the workspace starts a flow.
 *
 * GET  ?token=… → the fields to render
 * POST ?token=… → validate, coerce, and start a run
 *
 * AUTHENTICATION IS THE SAME SECRET the webhook trigger already uses, compared
 * the same way (hashed, timing-safe). A second secret scheme for the same
 * "anonymous caller starts this flow" problem would be a second thing to
 * rotate and a second thing to get wrong.
 *
 * The token travels in the QUERY STRING here rather than a header, because the
 * caller is a browser following a link and cannot set one. That is a real
 * downgrade — query strings land in logs and referrers — so the flow must be
 * ACTIVE, the endpoint is rate-limited per token, and the secret is
 * per-flow and rotatable. It is the same trade every hosted form makes.
 *
 * `systemPrisma`: there is no session here by construction. The flow id plus
 * the secret ARE the authorization, which is why both are checked before
 * anything is read back.
 */

type FlowRow = NonNullable<Awaited<ReturnType<typeof systemPrisma.flow.findFirst>>>
/** Explicit union so `'error' in result` narrows at every call site. */
type Authorized = { error: NextResponse; flow?: undefined } | { error?: undefined; flow: FlowRow }

async function authorize(request: NextRequest, id: string | undefined): Promise<Authorized> {
  const token = request.nextUrl.searchParams.get('token') ?? ''
  const flow = id ? await systemPrisma.flow.findFirst({ where: { id, status: 'ACTIVE' } }) : null
  const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger)
    ? flow.trigger
    : {}) as Record<string, unknown>
  const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null

  if (!flow || !hash || !token || !timingSafeEqualHex(hashToken(token), hash)) {
    recordSecurityEvent(
      webhookAuthFailureEvent(request, {
        route: 'flow.form',
        resourceId: id ?? 'unknown',
        reason: !flow ? 'unknown_resource' : !token ? 'missing_secret' : 'invalid_secret',
      }),
    )
    // Deliberately the same message and status for "no such flow" and "wrong
    // secret": distinguishing them turns this into an oracle for which flow
    // ids exist.
    return { error: NextResponse.json({ success: false, error: 'This form is not available.' }, { status: 401 }) }
  }
  if (trigger.type !== 'form') {
    return {
      error: NextResponse.json(
        { success: false, error: 'This flow is not configured as a form.' },
        { status: 409 },
      ),
    }
  }
  return { flow }
}

/** The fields to render. Deliberately does NOT reveal the flow's graph. */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-2)
  const authorized = await authorize(request, id)
  if (authorized.error) return authorized.error
  const { flow } = authorized

  const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
  const fields = parsed.success ? formFieldsFor(parsed.data) : []

  return NextResponse.json({
    success: true,
    // Name and description only — the graph, its steps and its connections are
    // workspace-internal and must not leak to an anonymous caller.
    title: flow.name,
    description: flow.description || '',
    fields,
  })
}

export async function POST(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-2)
  const authorized = await authorize(request, id)
  if (authorized.error) return authorized.error
  const { flow } = authorized

  // The same guard the webhook trigger uses: per-FLOW and per-IP. Per-flow
  // alone would let one source exhaust a workspace's run budget; per-IP alone
  // would not bound a distributed submission at all.
  if (await webhookThrottled(request, { key: 'flow.form', resourceId: flow.id, perResource: 60, perIp: 20 })) {
    return NextResponse.json({ success: false, error: 'Too many submissions — try again shortly.' }, { status: 429 })
  }

  const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
  const fields = parsed.success ? formFieldsFor(parsed.data) : []

  const body = await request.json().catch(() => ({}))
  const coerced = coerceFormSubmission(fields, body)
  if ('errors' in coerced) {
    return NextResponse.json({ success: false, errors: coerced.errors }, { status: 400 })
  }

  // Owned by the flow's owner, exactly as a webhook-triggered run is: an
  // anonymous submitter never becomes an actor in the workspace.
  if (!flow.userId) {
    return NextResponse.json({ success: false, error: 'This form is not available.' }, { status: 409 })
  }
  const run = await dispatchFlowExecution(
    { flowId: flow.id, organizationId: flow.organizationId, userId: flow.userId, input: coerced.values },
    { background: true },
  )

  // An acknowledgement, never the run's output — returning that would hand an
  // anonymous caller whatever the flow produced.
  return NextResponse.json({ success: true, runId: run.flowRunId ?? null })
}
