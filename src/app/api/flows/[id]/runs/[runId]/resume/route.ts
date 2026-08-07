import { NextRequest, NextResponse } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const maxDuration = 800

/**
 * External resume for a wait-until-webhook step: an outside system POSTs here
 * (authenticated with the FLOW's webhook trigger secret — the same credential
 * external callers already hold) and the request body becomes the waiting
 * wait step's output.
 *
 * Session-less by design (listed in route-permissions as differently
 * authenticated): the caller is an external service, not a user. Scoping is
 * the (flowId, runId) pair plus the per-flow secret hash; the run must
 * actually be waiting, so a replayed callback cannot restart a finished run.
 */
export async function POST(request: NextRequest) {
  const segments = request.nextUrl.pathname.split('/')
  const runId = segments.at(-2) ?? ''
  const flowId = segments.at(-4) ?? ''

  const limited = await rateLimit(`flow-resume:${flowId}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 })

  // systemPrisma: session-less external callback; flow id is globally unique
  // and the per-flow secret is the credential.
  const flow = flowId ? await systemPrisma.flow.findFirst({ where: { id: flowId } }) : null
  const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
  const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null
  const provided = request.headers.get('x-trigger-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  if (!flow || !hash || !provided || !timingSafeEqualHex(hashToken(provided), hash)) {
    return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
  }

  const run = await systemPrisma.flowRun.findFirst({
    where: { id: runId, flowId: flow.id, organizationId: flow.organizationId, status: 'waiting' },
    select: { id: true, userId: true },
  })
  if (!run) return NextResponse.json({ success: false, error: 'No waiting run found' }, { status: 404 })
  const actingUserId = run.userId ?? flow.userId
  if (!actingUserId) return NextResponse.json({ success: false, error: 'No waiting run found' }, { status: 404 })

  const body = await request.text().catch(() => '')
  const reply = body.trim() || '{}'
  const result = await dispatchFlowExecution({
    flowId: flow.id,
    organizationId: flow.organizationId,
    userId: actingUserId,
    flowRunId: run.id,
    reply,
  }, { background: true })
  const status = 'queued' in result ? 'queued' : result.status
  return NextResponse.json({ success: true, runId: run.id, status })
}
