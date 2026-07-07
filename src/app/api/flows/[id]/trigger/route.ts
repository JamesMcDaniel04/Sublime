import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runFlowExecution } from '@/features/flows/execute-flow'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const maxDuration = 300

// External webhook trigger for flows. Authenticated by the per-flow secret
// (hash stored in flow.trigger.webhookSecretHash) instead of a session — mirrors
// the agent trigger endpoint. Runs the PUBLISHED graph.
export async function POST(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per flow id to blunt secret-guessing floods.
    const limited = await rateLimit(`flow-trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000 })
    if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })

    const flow = await prisma.flow.findFirst({ where: { id, status: 'ACTIVE' } })
    const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null
    if (!flow || !hash || !timingSafeEqualHex(hashToken(provided), hash)) {
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }
    if (flow.publishedGraph == null) {
      return NextResponse.json({ success: false, error: 'Publish the flow before triggering it externally.' }, { status: 409 })
    }

    // The run is attributed to the flow's owner (or the org's oldest member).
    const owner = flow.userId
      ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
      : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
    if (!owner) return NextResponse.json({ success: false, error: 'No active user to attribute the run to' }, { status: 409 })

    const body = await request.json().catch(() => ({}))
    const input = typeof body?.input === 'string' ? body.input : JSON.stringify(body ?? {})
    const run = await runFlowExecution({
      flowId: flow.id,
      organizationId: flow.organizationId,
      userId: owner.id,
      input,
      usePublished: true,
      trigger: { type: 'webhook' },
    })
    return NextResponse.json({ success: true, run })
  } catch (error) {
    apiLogger.error('flow trigger failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
