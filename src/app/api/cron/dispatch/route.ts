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
import { agentConfigForRun } from '@/lib/agents/publish'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { diffPollResult, pollConfigFrom, pollIdentityOf, pollIsDue, type PollState } from '@/lib/flows/poll-trigger'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { dueOccurrence, isDue, type AgentSchedule } from '@/lib/scheduling/due'
import { getQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { EXECUTION_MODE, inlineExecution } from '@/lib/queue/execution-mode'
import { AGENT_PENDING_TIMEOUT_MS, AGENT_STUCK_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { reapStuckFlowRuns, reapOrphanedWaits } from '@/lib/flows/reap'
import { blocksSchedule } from '@/lib/flows/schedule-blocking'
import { captureError } from '@/lib/observability/sentry'
import { pruneSlackProcessedEvents } from '@/lib/slack/dedup'
import { inferActivityPatterns } from '@/lib/intelligence/infer-patterns'
import { runBehaviorIntelligence } from '@/lib/behavior/run-behavior-intelligence'
import { sweepUnindexedUserEvents } from '@/lib/behavior/index-user-event'
import { globalSweepsAllowed } from '@/lib/server/global-sweeps'
import { paymentRequiredOrgIds } from '@/lib/billing/enforce'
import { afterResponse } from '@/lib/server/after-response'
import { mapWithConcurrency } from '@/lib/server/concurrency'
import { encryptRunValue } from '@/lib/agents/run-crypto'

export const runtime = 'nodejs'
// 800 is Vercel's actual Pro-plan (fluid) ceiling — 1200 was silently clamped,
// so internal budgets sized against it overran the real limit and died with
// no clean error.
export const maxDuration = 800
export const dynamic = 'force-dynamic'

const MAX_AGENTS_PER_TICK = Number(process.env.MAX_AGENTS_PER_TICK) || 25
const MAX_FLOWS_PER_TICK = Number(process.env.MAX_FLOWS_PER_TICK) || 10
const STUCK_RUN_TIMEOUT_MS = AGENT_STUCK_TIMEOUT_MS
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
    // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
    await systemPrisma.agentExecution.updateMany({
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

    // A run stuck 'cancelling' means the worker died before its turn loop
    // could notice the flag — no live process will ever finalize it, and the
    // API rejects both a second cancel (not cancellable) and delete (not
    // terminal). Honor the user's intent and finalize it as cancelled.
    // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
    await systemPrisma.agentExecution.updateMany({
      where: {
        status: 'cancelling',
        startedAt: { lt: new Date(Date.now() - STUCK_RUN_TIMEOUT_MS) },
      },
      data: {
        status: 'cancelled',
        error: null,
        completedAt: new Date(),
      },
    })

    // A run still 'pending' far past the run window MAY never have made it
    // onto a worker (lost queue job) — without this it is uncancellable,
    // undeletable, and shows as active until the 90-day retention sweep. But
    // "old and pending" alone is NOT proof of loss: under a deep backlog the
    // job is still queued and will run. So verify against BullMQ — only rows
    // whose job is genuinely gone (or already dead) are failed. If Redis is
    // unreachable we skip the sweep entirely this tick: falsely failing live
    // runs is far worse than a stale pending row surviving 15 more minutes.
    try {
      // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
      const stalePending = await systemPrisma.agentExecution.findMany({
        where: {
          status: 'pending',
          startedAt: { lt: new Date(Date.now() - AGENT_PENDING_TIMEOUT_MS) },
        },
        select: { id: true },
        take: 500,
      })
      if (stalePending.length > 0 && workersEnabled && process.env.REDIS_URL) {
        const queue = getQueue(QUEUE_NAMES.AGENT_EXECUTION)
        const lostIds: string[] = []
        for (const row of stalePending) {
          // Manual/triggered runs enqueue with jobId = execution id.
          const job = await queue.getJob(row.id)
          if (!job) {
            lostIds.push(row.id)
            continue
          }
          const state = await job.getState().catch(() => 'unknown')
          if (state === 'failed' || state === 'completed' || state === 'unknown') lostIds.push(row.id)
        }
        if (lostIds.length > 0) {
          // systemPrisma: global reaper sweep — runs across all orgs by design (CRON_SECRET-gated).
          await systemPrisma.agentExecution.updateMany({
            where: { id: { in: lostIds }, status: 'pending' },
            data: { status: 'failed', error: 'Run never started (queue job lost)', completedAt: new Date() },
          })
        }
      }
    } catch (error) {
      apiLogger.error('cron/dispatch: pending reaper skipped (queue unreachable)', { error: capError(error) })
    }

    // Same recovery for flows: a crashed inline flow execution leaves its run
    // `running` forever, which also wedges that flow's schedule via the
    // overlap guard. Isolated so a reaper failure never aborts the tick.
    try {
      await reapStuckFlowRuns()
      await reapOrphanedWaits()
      // Fast path for a dead execution backend: zero-step runs will never
      // start while no worker heartbeat is live, so fail them at 5 minutes
      // instead of stranding "Thinking…" until the 30-minute reaper. Gated on
      // queue mode + dead heartbeat — under a healthy backlog a zero-step run
      // is legitimately waiting its turn.
      if (!inlineExecution) {
        const { checkFlowWorkerLiveness } = await import('@/lib/queue/worker-heartbeat')
        if (!(await checkFlowWorkerLiveness()).alive) {
          const { reapNeverStartedFlowRuns } = await import('@/lib/flows/reap')
          const reaped = await reapNeverStartedFlowRuns()
          if (reaped > 0) apiLogger.error('cron/dispatch: worker offline — failed never-started flow runs', { reaped })
        }
      }
    } catch (error) {
      apiLogger.error('cron/dispatch: flow reaper failed', { error: capError(error) })
      captureError(error, { source: 'cron.dispatch.flowReaper' })
    }

    // Slack thread sessions idle 7+ days are dead conversations — close them
    // so a months-later thread message starts fresh instead of resuming.
    // Isolated so a sweep failure never aborts the tick.
    try {
      const { closeStaleSlackSessions } = await import('@/lib/slack/session')
      await closeStaleSlackSessions()
    } catch (error) {
      apiLogger.error('cron/dispatch: slack session sweep failed', { error: capError(error) })
    }
    // Best-effort: drop claimed Slack dedup rows old enough that Slack would
    // no longer retry the same event_id/trigger_id — keeps the table bounded.
    await pruneSlackProcessedEvents().catch((error) => {
      apiLogger.error('cron/dispatch: slack dedup prune failed', { error: capError(error) })
    })
    // Behavior-ledger graph parity: project any rows the write-time indexer
    // missed. afterResponse (not a bare void): on Vercel, work not registered
    // with after() is killed the instant the response is flushed — a bare void
    // here silently never completed in production.
    afterResponse(() => sweepUnindexedUserEvents())
    const now = new Date()

    // Durable Wait nodes release their worker and resume on the first cron
    // tick at or after wakeAt. The execution path atomically claims
    // waiting->running, so overlapping cron invocations cannot resume twice.
    const DUE_WAITS_CAP = 200
    const dueWaits = await systemPrisma.flowRun.findMany({
      where: { status: 'waiting', wakeAt: { lte: now } },
      orderBy: { wakeAt: 'asc' },
      take: DUE_WAITS_CAP,
      select: { id: true, flowId: true, organizationId: true, userId: true, trigger: true },
    })
    if (dueWaits.length === DUE_WAITS_CAP) {
      apiLogger.warn('cron/dispatch: due-wait resume saturated its cap; oldest resumed first, rest next tick', { cap: DUE_WAITS_CAP })
    }
    // Unpaid workspaces get no background execution: skipping here (rather
    // than letting the dispatch throw) keeps the tick log clean and avoids
    // minting doomed run rows every 15 minutes. The billing gate inside
    // runAgentExecution/dispatchFlowExecution remains the backstop.
    const unpaidWaitOrgs = await paymentRequiredOrgIds([...new Set(dueWaits.map((waiting) => waiting.organizationId))])
    for (const waiting of dueWaits) {
      if (!waiting.userId) continue
      if (unpaidWaitOrgs.has(waiting.organizationId)) continue
      await dispatchFlowExecution({
        flowId: waiting.flowId,
        organizationId: waiting.organizationId,
        userId: waiting.userId,
        flowRunId: waiting.id,
        resumeReason: 'time',
        usePublished: (waiting.trigger as { type?: string } | null)?.type !== 'manual',
      }).catch((error) => apiLogger.error('cron/dispatch: timed flow resume failed', { flowRunId: waiting.id, error: capError(error) }))
    }

    // Single-owner scheduling: when the BullMQ worker is live in queue mode it
    // owns RECURRING dispatch (via its JobScheduler), so this cron must not also
    // dispatch recurring agents — otherwise they fire twice (double side effects
    // + token cost). One-time ("once") agents are never registered with the
    // BullMQ scheduler (repeatFor returns null for them), so this cron is the
    // only path that can fire them — dispatch those even in worker mode.
    const workerOwnsRecurring = workersEnabled && EXECUTION_MODE === 'queue'

    // Load active agents, longest-idle first. The order matters: this scan is
    // capped, and an unordered take() returned an arbitrary fixed subset — past
    // the cap, the same agents were evaluated every tick and the rest NEVER
    // fired while still showing "active" in the UI. lastExecutedAt asc (nulls
    // first) makes the cap self-rotating: dispatched agents move to the back.
    // systemPrisma: global scheduling scan — reads active agents across all orgs by design (CRON_SECRET-gated).
    const AGENT_SCAN_CAP = 1000
    const agents = await systemPrisma.agentTask.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { lastExecutedAt: { sort: 'asc', nulls: 'first' } },
      take: AGENT_SCAN_CAP,
      select: {
        id: true,
        agentType: true,
        description: true,
        objective: true,
        schedule: true,
        metadata: true,
        lastExecutedAt: true,
        userId: true,
        organizationId: true,
      },
    })
    if (agents.length === AGENT_SCAN_CAP) {
      apiLogger.warn('cron/dispatch: agent scan saturated its cap', { cap: AGENT_SCAN_CAP })
    }

    // Filter to agents whose schedule is currently due
    const allDueAgents = agents.filter((agent) => {
      // Published schedule when there is one — a draft edit must not change
      // when a production agent fires.
      const schedule = agentConfigForRun(agent).schedule as unknown as AgentSchedule | null
      if (!schedule || typeof schedule !== 'object') return false
      if (!isDue(schedule, agent.lastExecutedAt, now)) return false
      // In worker mode, only 'once' agents are dispatched here; recurring ones
      // are owned by the BullMQ JobScheduler.
      if (workerOwnsRecurring && schedule.type !== 'once') return false
      return true
    })
    const dueAgents = allDueAgents.slice(0, MAX_AGENTS_PER_TICK)
    if (allDueAgents.length > dueAgents.length) {
      // Never a silent cap: dropped agents are due NOW and simply wait for the
      // next tick (they stay due), but the operator should see the pressure.
      apiLogger.warn('cron/dispatch: per-tick agent cap deferred due agents', {
        cap: MAX_AGENTS_PER_TICK,
        deferred: allDueAgents.length - dueAgents.length,
      })
    }

    // Same billing pre-filter for scheduled agents.
    const unpaidAgentOrgs = await paymentRequiredOrgIds([...new Set(dueAgents.map((agent) => agent.organizationId))])
    const billableAgents = dueAgents.filter((agent) => !unpaidAgentOrgs.has(agent.organizationId))
    if (billableAgents.length < dueAgents.length) {
      apiLogger.info('cron/dispatch: skipped agents for unpaid workspaces', {
        skipped: dueAgents.length - billableAgents.length,
      })
    }

    const dueCount = billableAgents.length
    const ranIds: string[] = []

    for (const agent of billableAgents) {
      // I2 — advance lastExecutedAt BEFORE running so that even a persistently
      // failing (or throwing) agent does not re-fire on every tick. The whole
      // per-agent body is wrapped so one agent can never abort the tick.
      try {
        await prisma.agentTask.update({
          where: { id: agent.id, organizationId: agent.organizationId },
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
            input: encryptRunValue({ prompt: input }),
            trigger: { type: 'schedule' },
            metadata: { title: (metadata.title as string) || agent.description },
            userId: user.id,
            organizationId: agent.organizationId,
          },
        })

        try {
          if (workerOwnsRecurring) {
            // Queue mode with a live worker: run on the worker, not inside
            // this serverless function — a long run here would be killed at
            // the platform's duration ceiling (Vercel Pro caps below our
            // 1200s maxDuration) before the internal timeouts can fire.
            const queue = getQueue(QUEUE_NAMES.AGENT_EXECUTION)
            await queue.add(
              'execute-agent',
              {
                executionId: execution.id,
                agentId: agent.id,
                organizationId: agent.organizationId,
                userId: user.id,
                input,
              },
              { jobId: execution.id },
            )
          } else {
            await runAgentExecution({
              executionId: execution.id,
              agentId: agent.id,
              organizationId: agent.organizationId,
              userId: user.id,
              input,
            })
          }
          ranIds.push(agent.id)
        } catch (error) {
          apiLogger.error('cron/dispatch: agent execution failed', {
            agentId: agent.id,
            executionId: execution.id,
            error: capError(error),
          })
          await prisma.agentExecution.update({
            where: { id: execution.id, organizationId: agent.organizationId },
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
    // systemPrisma: global scheduling scan — reads active flows across all orgs by design (CRON_SECRET-gated).
    // select (not include): the scheduling decision needs the trigger and a
    // published-graph existence check — loading every ACTIVE flow's draft
    // graph, metadata, and collaboration log pulled megabytes through the
    // pooler each tick for nothing.
    const FLOW_SCAN_CAP = 500
    const flows = await systemPrisma.flow.findMany({
      // Denormalized-column narrowing: only published, schedule-triggered
      // flows are scanned (previously every ACTIVE flow's publishedGraph was
      // loaded per tick just to check it wasn't null).
      where: { status: 'ACTIVE', triggerType: 'schedule', isPublished: true },
      orderBy: { updatedAt: 'asc' },
      take: FLOW_SCAN_CAP,
      select: {
        id: true,
        userId: true,
        organizationId: true,
        trigger: true,
        runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true, status: true, wakeAt: true } },
      },
    })
    if (flows.length === FLOW_SCAN_CAP) {
      apiLogger.warn('cron/dispatch: flow scan saturated its cap', { cap: FLOW_SCAN_CAP })
    }
    const ranFlowIds: string[] = []
    // Same billing pre-filter for scheduled flows.
    const unpaidFlowOrgs = await paymentRequiredOrgIds([...new Set(flows.map((flow) => flow.organizationId))])
    for (const flow of flows) {
      try {
        if (unpaidFlowOrgs.has(flow.organizationId)) continue
        const trigger = flow.trigger as { type?: string; schedule?: AgentSchedule; input?: string } | null
        const schedule = trigger?.schedule
        if (!trigger || trigger.type !== 'schedule' || !schedule || typeof schedule !== 'object') continue
        // Publish state is enforced in the WHERE (isPublished: true) — a
        // draft-only flow never reaches this loop.
        const scheduledFor = dueOccurrence(schedule, flow.runs[0]?.startedAt ?? null, now)
        if (!scheduledFor) continue
        // Overlap guard: a still-active previous run means skip this tick —
        // a slow flow must never stack concurrent scheduled executions. A
        // `waiting` run older than 24h stops blocking (blocksSchedule): it
        // stays answerable, but an unanswered question must not
        // wedge the schedule forever.
        const lastRun = flow.runs[0]
        if (lastRun && blocksSchedule(lastRun, now)) {
          apiLogger.warn('cron/dispatch: flow run still active, skipping tick', { flowId: flow.id })
          continue
        }
        if (ranFlowIds.length >= MAX_FLOWS_PER_TICK) break
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
          : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
        if (!owner) continue
        await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: flow.organizationId,
          userId: owner.id,
          input: parseFlowInput(trigger.input ?? ''),
          usePublished: true,
          trigger: { type: 'schedule', scheduledFor: scheduledFor.toISOString() },
          idempotencyKey: `schedule:${flow.id}:${scheduledFor.toISOString()}`,
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

    // ── Poll-triggered flows: run each due source read, diff against the
    // seen-identity cursor (Flow.metadata.pollState), and dispatch ONE run
    // per new item with that item as the trigger input. The first poll
    // baselines silently; a failing source still advances lastPollAt so a
    // broken connection can't hot-loop every tick.
    const POLL_SCAN_CAP = 200
    const pollFlows = await systemPrisma.flow.findMany({
      where: { status: 'ACTIVE', triggerType: 'poll', isPublished: true },
      orderBy: { updatedAt: 'asc' },
      take: POLL_SCAN_CAP,
      select: { id: true, userId: true, organizationId: true, trigger: true, metadata: true },
    })
    if (pollFlows.length === POLL_SCAN_CAP) {
      apiLogger.warn('cron/dispatch: poll scan saturated its cap', { cap: POLL_SCAN_CAP })
    }
    const unpaidPollOrgs = await paymentRequiredOrgIds([...new Set(pollFlows.map((flow) => flow.organizationId))])
    let polledFlows = 0
    for (const flow of pollFlows) {
      const metadata = flow.metadata && typeof flow.metadata === 'object' && !Array.isArray(flow.metadata)
        ? (flow.metadata as Record<string, unknown>)
        : {}
      const state: PollState = metadata.pollState && typeof metadata.pollState === 'object' && !Array.isArray(metadata.pollState)
        ? (metadata.pollState as PollState)
        : {}
      try {
        if (unpaidPollOrgs.has(flow.organizationId)) continue
        const config = pollConfigFrom(flow.trigger)
        if (!config || !pollIsDue(state, config.intervalMinutes, now)) continue
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
          : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
        if (!owner) continue
        const { plane, ref } = parseFlowToolConnectionId(config.connectionId)
        const executor = await resolveFlowToolExecutor({
          organizationId: flow.organizationId, userId: owner.id, plane, ref, toolName: config.toolName,
        })
        let args: Record<string, unknown> = {}
        if (config.args) {
          try { args = JSON.parse(config.args) as Record<string, unknown> } catch { args = {} }
        }
        const result = await executor.execute(config.toolName, args)
        const { newItems, nextState } = diffPollResult(result, state, config, now)
        for (const item of newItems) {
          const identity = pollIdentityOf(item, config.idPath ?? 'id')
          await dispatchFlowExecution({
            flowId: flow.id,
            organizationId: flow.organizationId,
            userId: owner.id,
            input: item,
            usePublished: true,
            trigger: { type: 'poll', identity },
            idempotencyKey: `poll:${flow.id}:${identity}`,
          })
        }
        // Cursor-after-dispatch: if any DB/outbox transaction above fails, the
        // cursor stays put. The next tick replays prior items through their
        // stable idempotency keys before advancing, so nothing is lost.
        await systemPrisma.flow.updateMany({
          where: { id: flow.id },
          data: { metadata: JSON.parse(JSON.stringify({ ...metadata, pollState: nextState })) },
        })
        polledFlows += 1
      } catch (error) {
        apiLogger.warn('cron/dispatch: poll check failed, advancing cursor', {
          flowId: flow.id, organizationId: flow.organizationId, error: capError(error),
        })
        // Advance lastPollAt only — identities stay so nothing is skipped.
        await systemPrisma.flow.updateMany({
          where: { id: flow.id },
          data: { metadata: JSON.parse(JSON.stringify({ ...metadata, pollState: { ...state, lastPollAt: now.toISOString() } })) },
        }).catch(() => undefined)
        continue
      }
    }
    if (polledFlows > 0) apiLogger.info('cron/dispatch: polled flow sources', { polledFlows })

    // Weekly workflow-suggestion synthesis: only attempted in the Monday
    // 09:00 UTC hour (this cron ticks every 15 minutes, so up to 4 attempts
    // land in that window) — synthesizeWorkflowSuggestions itself enforces
    // <=1 run/org/day, so the first attempt in the window does the work and
    // the rest return immediately. Also fires per-scan (see connection-scan.ts);
    // that per-org daily guard is what actually keeps this to a weekly cadence
    // for quiet orgs and prevents double-firing with the post-scan hook.
    let suggestionOrgsChecked = 0
    if (now.getUTCDay() === 1 && now.getUTCHours() === 9) {
      const { synthesizeWorkflowSuggestions } = await import('@/lib/intelligence/suggest-workflows')
      // systemPrisma: global weekly sweep — reads orgs across all tenants by design (CRON_SECRET-gated).
      const ORG_SWEEP_CAP = 2000
      const orgs = await systemPrisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: ORG_SWEEP_CAP })
      if (orgs.length === ORG_SWEEP_CAP) {
        apiLogger.warn('cron/dispatch: synthesis org sweep saturated its cap', { cap: ORG_SWEEP_CAP })
      }
      // LLM-backed and org-count-bound: run after the response with bounded
      // parallelism instead of serially inside the tick (500 orgs of serial
      // LLM synthesis would blow the function budget with the response held).
      afterResponse(() =>
        mapWithConcurrency(orgs, 5, async (org) => {
          try {
            await synthesizeWorkflowSuggestions(org.id)
          } catch (error) {
            apiLogger.error('cron/dispatch: workflow suggestion synthesis failed', {
              organizationId: org.id,
              error: capError(error),
            })
          }
        }),
      )
      suggestionOrgsChecked = orgs.length
    }

    // Daily k-anonymous template adoption counts. Runs an hour before the
    // archetype and benchmark sweeps, both of which read adoption scores, so
    // they consume fresh counts rather than yesterday's.
    // All sweeps below run through afterResponse (never a bare `void`): on
    // Vercel, work not registered with after() is frozen with the lambda the
    // instant the response is flushed — these sweeps silently never completed
    // in production, and any sweep that claims its daily/weekly slot before
    // doing the work burned the slot with nothing to show for it.
    {
      const adoption = await import('@/lib/templates/aggregate-adoption')
      if (globalSweepsAllowed() && adoption.shouldRunAdoptionSweep(now)) {
        afterResponse(() => adoption.aggregateTemplateAdoption())
      }
    }

    // Daily platform-archetype aggregation (intelligence phase 3): k-anonymous
    // cross-org automation shapes, gated on the tested pure window guard.
    // Fire-and-forget — a failed sweep logs and retries tomorrow, never
    // extends the tick.
    {
      const archetypes = await import('@/lib/intelligence/aggregate-archetypes')
      if (globalSweepsAllowed() && archetypes.shouldRunArchetypeSweep(now)) {
        afterResponse(() => archetypes.aggregatePlatformArchetypes())
      }
    }

    // Weekly k-anonymous calibration of catalogue time estimates. This global
    // sweep stores only aggregate seed defaults and never rewrites existing links.
    {
      const calibration = await import('@/lib/goals/calibrate-estimates')
      if (globalSweepsAllowed() && calibration.shouldRunEstimateCalibration(now)) {
        afterResponse(() => calibration.calibrateTemplateEstimates())
      }
    }

    // Weekly anonymous outcome counts by goal kind. Rows are global aggregates
    // and stay invisible until the five-organization floor is met.
    {
      const benchmarks = await import('@/lib/goals/aggregate-benchmarks')
      if (globalSweepsAllowed() && benchmarks.shouldRunGoalBenchmarkSweep(now)) {
        afterResponse(() => benchmarks.aggregateGoalBenchmarks())
      }
    }

    // Weekly goal tending: per-user atomic claims prevent retries in this
    // 15-minute Monday window from double-sending.
    {
      const digest = await import('@/lib/goals/digest')
      if (globalSweepsAllowed() && digest.shouldRunWeeklyGoalDigest(now)) {
        // Email sends are claim-logged and FAILED claims are retryable; a
        // frozen batch resumes safely on the next tick without double-send.
        afterResponse(() => digest.sendWeeklyGoalDigests(now))
      }
    }

    // Daily lifecycle email sweep. Claims live in email_sends, so retried cron
    // ticks are safe and transport failures remain retryable.
    {
      const lifecycle = await import('@/lib/lifecycle/emails')
      if (globalSweepsAllowed() && lifecycle.shouldRunLifecycleSweep(now)) {
        afterResponse(() => lifecycle.runLifecycleSweep(now))
      }
    }

    // Live knowledge sync, periodic leg: once a day (first 15-min tick after
    // 05:00 UTC), re-scan connections whose captured usage profile is stale so
    // knowledge tracks how connected tools are actually used — not just their
    // state at connect time. Fire-and-forget: bounded inside, never extends
    // or fails the tick.
    if (now.getUTCHours() === 5 && now.getUTCMinutes() < 15) {
      afterResponse(() =>
        import('@/lib/intelligence/connection-resync').then(({ resyncStaleConnections }) => resyncStaleConnections()),
      )
    }

    // Activity freshness leg: EVERY tick, incremental-sync sources with no
    // live event path (github, calendar, hubspot, granola) so the ledger — and
    // the usage-evidence gate, persona, and patterns downstream — keeps
    // tracking reality after the one-shot connect backfill. This used to fire
    // only in the 06:00 UTC window, which made all non-Slack integration data
    // up to a day stale by design — and a whole day staler whenever that one
    // tick was delayed past the window or died. Per-tick is safe: `since`
    // derives from the ledger with a 1h overlap and dedupeKey dedupes it, so
    // each tick fetches only the delta. Bounded and fire-and-forget: never
    // extends or fails the tick. globalSweepsAllowed: cross-org enumeration,
    // so it must stay inert against the shared test database.
    if (globalSweepsAllowed()) {
      afterResponse(() =>
        import('@/lib/activity/incremental-sync').then(({ sweepIncrementalSync }) => sweepIncrementalSync()),
      )
    }

    // Revisit orgs that observed activity in the last day. Inference is
    // best-effort background work and must not extend or fail the cron tick —
    // afterResponse keeps it alive past the response, and the bounded fan-out
    // (5 orgs at a time, not one unbounded promise per org) keeps hundreds of
    // pipelines from contending for the instance's small Prisma pool at once.
    // Both scans are bounded + ordered: a silent cap would mean orgs past it
    // never get inference with no signal anywhere, so saturation is logged.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const SWEEP_ORG_CAP = 500
    const recentActivityOrgs = await systemPrisma.activityEvent.groupBy({
      by: ['organizationId'],
      where: { ingestedAt: { gte: dayAgo } },
      orderBy: { organizationId: 'asc' },
      take: SWEEP_ORG_CAP,
    })
    if (recentActivityOrgs.length === SWEEP_ORG_CAP) {
      apiLogger.warn('cron/dispatch: activity-org sweep saturated its cap; orgs beyond it skipped this tick', { cap: SWEEP_ORG_CAP })
    }
    afterResponse(() =>
      mapWithConcurrency(recentActivityOrgs, 5, ({ organizationId }) => inferActivityPatterns(organizationId)),
    )

    // Same cadence for in-app behavior: orgs whose users acted in the last
    // day get a per-user inference + (self-throttled) synthesis pass.
    const recentBehaviorOrgs = await systemPrisma.userEvent.groupBy({
      by: ['organizationId'],
      where: { occurredAt: { gte: dayAgo } },
      orderBy: { organizationId: 'asc' },
      take: SWEEP_ORG_CAP,
    })
    if (recentBehaviorOrgs.length === SWEEP_ORG_CAP) {
      apiLogger.warn('cron/dispatch: behavior-org sweep saturated its cap; orgs beyond it skipped this tick', { cap: SWEEP_ORG_CAP })
    }
    afterResponse(async () => {
      const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
      await mapWithConcurrency(recentBehaviorOrgs, 5, async ({ organizationId }) => {
        await runBehaviorIntelligence(organizationId).catch(() => undefined)
        // Goal work learning: earn targeting rules from what humans did with
        // agent output, retire the ones probes disproved. Best-effort in the
        // same shape — a learning failure must not break the sweep.
        await runGoalWorkLearning(organizationId).catch(() => undefined)
      })
    })

    // Goal metric freshness + evaluation: per-metric throttling happens
    // inside; source failures land on GoalMetric.lastError and never fail the
    // CRON_SECRET-gated tick.
    // Unlike the sweeps above this has no time window, so under a shared test
    // database it collided on EVERY tick — a suite's tick restamped another
    // suite's metrics mid-assertion. That was the flake tracked down the hard
    // way; the guard removes the cause rather than the symptom.
    if (globalSweepsAllowed()) {
      afterResponse(() => import('@/lib/goals/refresh').then(({ refreshGoalMetrics }) => refreshGoalMetrics()))
    }

    return Response.json({
      success: true,
      due: dueCount,
      ran: ranIds,
      ranFlows: ranFlowIds,
      suggestionOrgsChecked,
      activityOrgsChecked: recentActivityOrgs.length,
      behaviorOrgsChecked: recentBehaviorOrgs.length,
    })
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
