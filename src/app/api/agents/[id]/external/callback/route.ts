import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { webhookAuthFailureEvent, webhookThrottled } from '@/lib/server/webhook-guard'
import { interpretCallbackBody, verifyCallbackToken } from '@/lib/agents/external-agent'
import { settleExternalRun, WAITING_FOR_EXTERNAL } from '@/lib/agents/external-run'

export const runtime = 'nodejs'

const bodySchema = z.object({
  runId: z.string().min(1).max(64),
  status: z.enum(['completed', 'failed']).optional(),
  output: z.unknown().optional(),
  error: z.string().max(2000).optional(),
})

/**
 * Where an external agent posts its answer.
 *
 * Authenticated by the single-use, run-bound token Sublime sent with the ask
 * — not by a session, not by the agent's endpoint secret. The token's hash
 * lives on the execution and is cleared by the settle write, so a replayed
 * callback, a callback after a cancel, or one after the deadline reaper all
 * fail the same status-guarded lookup and get the same 401.
 */
export async function POST(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-3) ?? ''
  if (await webhookThrottled(request, { key: 'external-callback', resourceId: id || 'unknown' })) {
    return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
  }
  const presented =
    request.headers.get('x-callback-token') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!id || !presented || !parsed.success) {
    recordSecurityEvent(webhookAuthFailureEvent(request, { route: 'agent.external_callback', resourceId: id || 'unknown', reason: 'missing_secret' }))
    return NextResponse.json({ success: false, error: 'Missing callback token or body' }, { status: 401 })
  }

  // systemPrisma: session-less callback; the run id is globally unique and the
  // token is bound to exactly one run, so the lookup IS the tenant resolution.
  const execution = await systemPrisma.agentExecution.findFirst({
    where: { id: parsed.data.runId, agentTaskId: id, status: WAITING_FOR_EXTERNAL },
    select: { id: true, organizationId: true, agentTaskId: true, userId: true, metadata: true, trigger: true },
  })
  const metadata = execution?.metadata && typeof execution.metadata === 'object' ? (execution.metadata as Record<string, unknown>) : {}
  const hash = typeof metadata.externalCallbackHash === 'string' ? metadata.externalCallbackHash : null
  if (!execution || !execution.organizationId || !execution.agentTaskId || !verifyCallbackToken(presented, hash)) {
    // Same 401 whether the run is unknown, already settled, or the token is
    // wrong — no oracle. The security signal distinguishes them.
    recordSecurityEvent(webhookAuthFailureEvent(request, { route: 'agent.external_callback', resourceId: id, reason: execution ? 'invalid_secret' : 'unknown_resource' }))
    return NextResponse.json({ success: false, error: 'Invalid callback token' }, { status: 401 })
  }

  const trigger = execution.trigger && typeof execution.trigger === 'object' ? (execution.trigger as Record<string, unknown>) : {}
  const outcome = interpretCallbackBody(parsed.data)
  const settled = await settleExternalRun({
    organizationId: execution.organizationId,
    executionId: execution.id,
    agentId: execution.agentTaskId,
    userId: execution.userId,
    outcome: outcome.kind === 'accepted' ? { kind: 'failed', error: 'A callback must carry a result.' } : outcome,
    requestId: typeof trigger.requestId === 'string' ? trigger.requestId : null,
  })
  if (!settled) return NextResponse.json({ success: false, error: 'Invalid callback token' }, { status: 401 })
  return NextResponse.json({ success: true, status: outcome.kind === 'completed' ? 'completed' : 'failed' })
}
