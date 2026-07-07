/**
 * /api/cron/dispatch — Vercel Cron handler
 *
 * Invoked by the Vercel cron entry (see vercel.json). Scheduling is catch-up
 * based, not tick-aligned: for each active agentTask, `isDue` checks whether
 * any scheduled minute has elapsed since the agent's last run (e.g. a cron of
 * "0 9 * * *" still fires even if the dispatch tick lands at 13:00, not 09:00).
 * For every due agent it creates an agentExecution row and runs it inline.
 *
 * Auth (fail closed): CRON_SECRET env var MUST be set. If it is not configured
 * the handler returns 503. When set, requests must carry:
 *   Authorization: Bearer <CRON_SECRET>
 * compared in constant time. There is no header-only bypass in any environment.
 */

import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { runFlowExecution } from '@/features/flows/execute-flow'
import { isDue, type AgentSchedule } from '@/lib/scheduling/due'
import { workersEnabled } from '@/lib/queue/config'
import { EXECUTION_MODE } from '@/lib/queue/execution-mode'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const MAX_AGENTS_PER_TICK = 25
const STUCK_RUN_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const MAX_ERROR_LENGTH = 300

function capError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_ERROR_LENGTH)
}

/**
 * Fail-closed auth. CRON_SECRET must be configured; otherwise the handler is
 * unavailable. When set, the request must present a matching bearer token,
 * compared in constant time over equal-length buffers. No header-only bypass.
 *
 * Returns null when authorized, or a Response to short-circuit with.
 */
function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 503 },
    )
  }

  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  const authorized = a.length === b.length && timingSafeEqual(a, b)
  if (!authorized) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  try {
    // I5 — reap stuck runs: any execution still "running" past the time limit
    // is marked failed so it doesn't pin resources or block reporting.
    await prisma.agentExecution.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: new Date(Date.now() - STUCK_RUN_TIMEOUT_MS) },
      },
      data: {
        status: 'failed',
        error: 'Run exceeded time limit',
        completedAt: new Date(),
      },
    })

    // Single-owner scheduling: when the BullMQ worker is live in queue mode it
    // owns RECURRING dispatch (via its JobScheduler), so this cron must not also
    // dispatch recurring agents — otherwise they fire twice (double side effects
    // + token cost). One-time ("once") agents are never registered with the
    // BullMQ scheduler (repeatFor returns null for them), so this cron is the
    // only path that can fire them — dispatch those even in worker mode.
    const workerOwnsRecurring = workersEnabled && EXECUTION_MODE === 'queue'

    // Load all active agents (capped at 200 to avoid huge fetches)
    const agents = await prisma.agentTask.findMany({
      where: { status: 'ACTIVE' },
      take: 200,
    })

    const now = new Date()

    // Filter to agents whose schedule is currently due
    const dueAgents = agents
      .filter((agent) => {
        const schedule = agent.schedule as unknown as AgentSchedule | null
        if (!schedule || typeof schedule !== 'object') return false
        if (!isDue(schedule, agent.lastExecutedAt, now)) return false
        // In worker mode, only 'once' agents are dispatched here; recurring ones
        // are owned by the BullMQ JobScheduler.
        if (workerOwnsRecurring && schedule.type !== 'once') return false
        return true
      })
      .slice(0, MAX_AGENTS_PER_TICK)

    const dueCount = dueAgents.length
    const ranIds: string[] = []

    for (const agent of dueAgents) {
      // I2 — advance lastExecutedAt BEFORE running so that even a persistently
      // failing (or throwing) agent does not re-fire on every tick. The whole
      // per-agent body is wrapped so one agent can never abort the tick.
      try {
        await prisma.agentTask.update({
          where: { id: agent.id },
          data: {
            lastExecutedAt: new Date(),
            executionCount: { increment: 1 },
          },
        })

        const metadata =
          agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata)
            ? (agent.metadata as Record<string, unknown>)
            : {}

        // Attribute the run to the agent's owner when set; otherwise the org's
        // oldest active member (shared agents have no single owner).
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
          apiLogger.error('cron/dispatch: no active user found, skipping agent', {
            agentId: agent.id,
            organizationId: agent.organizationId,
          })
          continue
        }

        // Pass the raw objective — runAgentExecution composes skills into the
        // system prompt itself, so composing here too would double-apply them.
        const input = agent.objective

        // Create the execution row in pending state
        const execution = await prisma.agentExecution.create({
          data: {
            agentType: agent.agentType,
            agentTaskId: agent.id,
            status: 'pending',
            input: { prompt: input },
            trigger: { type: 'schedule' },
            metadata: { title: (metadata.title as string) || agent.description },
            userId: user.id,
            organizationId: agent.organizationId,
          },
        })

        try {
          await runAgentExecution({
            executionId: execution.id,
            agentId: agent.id,
            organizationId: agent.organizationId,
            userId: user.id,
            input,
          })
          ranIds.push(agent.id)
        } catch (error) {
          apiLogger.error('cron/dispatch: agent execution failed', {
            agentId: agent.id,
            executionId: execution.id,
            error: capError(error),
          })
          await prisma.agentExecution.update({
            where: { id: execution.id },
            data: {
              status: 'failed',
              error: capError(error),
              completedAt: new Date(),
            },
          })
        }
      } catch (error) {
        // Any failure in the per-agent body (user lookup, execution row
        // creation, etc.) is isolated so the tick continues with other agents.
        apiLogger.error('cron/dispatch: agent dispatch failed, skipping', {
          agentId: agent.id,
          organizationId: agent.organizationId,
          error: capError(error),
        })
        continue
      }
    }

    // Scheduled flows: reuse the same due-check. A flow's schedule lives at
    // flow.trigger.schedule (a real AgentSchedule: hourly/daily/weekly/cron/once);
    // its most-recent flow_run.startedAt is the "last run" marker. Recurring
    // flows are owned by this cron (no BullMQ scheduler for flows), so run them
    // even in worker mode.
    const flows = await prisma.flow.findMany({
      where: { status: 'ACTIVE' },
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true } } },
      take: 100,
    })
    const ranFlowIds: string[] = []
    for (const flow of flows) {
      try {
        const trigger = flow.trigger as { type?: string; schedule?: AgentSchedule; input?: string } | null
        const schedule = trigger?.schedule
        if (!trigger || trigger.type !== 'schedule' || !schedule || typeof schedule !== 'object') continue
        // Only PUBLISHED flows run on a schedule — a draft-only flow does not fire.
        if (flow.publishedGraph == null) continue
        if (!isDue(schedule, flow.runs[0]?.startedAt ?? null, now)) continue
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
          : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
        if (!owner) continue
        await runFlowExecution({
          flowId: flow.id,
          organizationId: flow.organizationId,
          userId: owner.id,
          input: trigger.input ?? '',
          usePublished: true,
          trigger: { type: 'schedule' },
        })
        ranFlowIds.push(flow.id)
      } catch (error) {
        apiLogger.error('cron/dispatch: flow dispatch failed, skipping', {
          flowId: flow.id,
          organizationId: flow.organizationId,
          error: capError(error),
        })
        continue
      }
    }

    return Response.json({ success: true, due: dueCount, ran: ranIds, ranFlows: ranFlowIds })
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
