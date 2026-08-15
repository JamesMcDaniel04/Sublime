import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { apiLogger } from '@/lib/logger'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { validateTriggerSecret } from '@/lib/agents/trigger-secret'
import { rateLimit } from '@/lib/ratelimit'
import { agentWebhookEventName, agentWebhookInput } from '@/lib/agents/webhook-input'
import { assertOrganizationBillingActive } from '@/lib/billing/enforce'

export const runtime = 'nodejs'
// 800 is Vercel's actual Pro-plan (fluid) ceiling — 1200 was silently clamped,
// so internal budgets sized against it overran the real limit and died with
// no clean error.
export const maxDuration = 800

// External trigger for agents (webhooks, API calls, Pipedream event sources).
// Authenticated by the per-agent secret instead of a Supabase session.
export async function POST(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per agent id to blunt secret-guessing and
    // trigger floods before any DB work.
    const limited = await rateLimit(`trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000 })
    if (!limited.ok) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
    }
    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) {
      return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })
    }

    // systemPrisma: session-less webhook trigger (per-agent secret, no org context); agent id is globally unique.
  const agent = await systemPrisma.agentTask.findFirst({ where: { id, status: 'ACTIVE' } })
    const metadata = agent?.metadata && typeof agent.metadata === 'object' ? agent.metadata as Record<string, unknown> : {}
    const secretCheck = agent ? validateTriggerSecret(provided, metadata) : { valid: false, upgrade: null }
    if (!agent || !secretCheck.valid) {
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }

    // A successful legacy plaintext match upgrades the row in place (hash +
    // ciphertext, plaintext deleted) so the plaintext population only ever
    // shrinks. Best-effort: the trigger must not fail over housekeeping.
    if (secretCheck.upgrade) {
      // systemPrisma: same session-less path as the lookup above.
      await systemPrisma.agentTask
        .update({ where: { id: agent.id }, data: { metadata: secretCheck.upgrade as Prisma.InputJsonValue } })
        .catch(() => undefined)
    }

    // Billing gate before any execution row exists: external callers get an
    // honest 402 instead of a run that the execution choke point would fail.
    try {
      await assertOrganizationBillingActive(agent.organizationId)
    } catch {
      return NextResponse.json(
        { success: false, error: 'This workspace needs an active plan before agents can run.' },
        { status: 402 },
      )
    }

    const body = await request.json().catch(() => ({})) as unknown
    // Skills are composed into the system prompt inside runAgentExecution — pass
    // the raw objective so attached skills aren't applied twice.
    const input = agentWebhookInput(body, agent.objective)
    const eventName = agentWebhookEventName(body, request.headers.get('x-event-type'))

    // Attribute the run to the agent's owner when set; otherwise fall back to
    // the org's oldest active member (shared agents have no single owner).
    const owner = agent.userId
      ? await prisma.user.findFirst({
          where: { id: agent.userId, organizationId: agent.organizationId, isActive: true },
        })
      : null
    const user =
      owner ||
      (await prisma.user.findFirst({
        where: { organizationId: agent.organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
      }))
    if (!user) {
      return NextResponse.json({ success: false, error: 'No active user in organization' }, { status: 409 })
    }

    // Idempotency: at-least-once/retrying senders (Pipedream, monitors) can
    // deliver the same event twice. When they supply a key, a duplicate returns
    // the existing execution instead of firing the agent again — reusing the
    // @@unique([organizationId, idempotencyKey]) constraint.
    const idempotencyKey = request.headers.get('x-idempotency-key')?.trim() || undefined

    let execution
    try {
      execution = await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'pending',
          input: { prompt: input },
          trigger: { type: 'webhook', ...(eventName ? { event: eventName } : {}) },
          metadata: { title: (metadata.title as string) || agent.description },
          userId: user.id,
          organizationId: agent.organizationId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      })
    } catch (error) {
      if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.agentExecution.findFirst({
          where: { organizationId: agent.organizationId, idempotencyKey },
        })
        if (existing) {
          return NextResponse.json({ success: true, executionId: existing.id, status: existing.status, duplicate: true })
        }
      }
      throw error
    }

    if (inlineExecution) {
      try {
        const result = await runAgentExecution({
          executionId: execution.id,
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: user.id,
          input,
        })
        return NextResponse.json({ success: true, executionId: execution.id, result })
      } catch (error) {
        // systemPrisma: session-less trigger path; execution id was minted org-scoped above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'failed',
            // M5 — cap persisted error strings so they can't bloat the row.
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
            completedAt: new Date(),
          },
        })
        return NextResponse.json({ success: false, error: 'Agent run failed' }, { status: 500 })
      }
    } else {
      if (!workersEnabled) {
        return NextResponse.json({ success: false, error: 'Agent worker is disabled' }, { status: 503 })
      }
      const queue = getQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('execute-agent', {
        executionId: execution.id,
        agentId: agent.id,
        organizationId: agent.organizationId,
        userId: user.id,
        input,
      }, { jobId: execution.id })

      return NextResponse.json({ success: true, executionId: execution.id, status: 'pending' })
    }
  } catch (error) {
    apiLogger.error('Agent trigger failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
