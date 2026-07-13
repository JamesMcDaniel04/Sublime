import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { matchSlackFlows, slackTriggerConfigOf, type SlackTriggerConfig } from '@/lib/slack/route-event'
import { claimSlackEvent } from '@/lib/slack/dedup'
import { findOpenSession, resolveSessionRouting, upsertThreadSession, closeSession } from '@/lib/slack/session'
import type { NormalizedSlackEvent, SlackTriggerInput } from '@/lib/slack/payload'
import { ingestActivity } from '@/lib/activity/ingest'
import { slackActivityFromInput } from '@/lib/activity/sources/slack'

export type SlackRouteArgs = {
  bindingId: string
  organizationId: string
  botUserId: string
  normalized: NormalizedSlackEvent
}

/** The origin block persisted at trigger.slack on every slack-triggered run —
 * the Task 6 reply hook reads exactly this shape. */
export function slackRunTrigger(bindingId: string, input: SlackTriggerInput) {
  const threadTs = input.thread_ts ?? (input.ts || undefined)
  return {
    type: 'slack' as const,
    slack: {
      bindingId,
      channel: input.channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(input.response_url ? { response_url: input.response_url } : {}),
      kind: input.kind,
    },
  }
}

/** Owner attribution mirrors the webhook trigger: the flow's owner, or the
 * org's oldest active member. */
async function resolveRunOwner(flow: { userId: string | null; organizationId: string }) {
  return flow.userId
    ? prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
    : prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
}

/**
 * Ingress precedence: a non-bot message in a thread with an open
 * SlackThreadSession is a CONTINUATION of that conversation, not a fresh
 * trigger match — resolved and dispatched here, before normal trigger
 * matching ever runs. Returns true when the event was fully handled
 * (caller must not also run normal matching), false to fall through.
 */
async function tryThreadContinuation(args: {
  bindingId: string
  organizationId: string
  input: SlackTriggerInput
}): Promise<boolean> {
  const { bindingId, organizationId, input } = args
  if (!input.thread_ts) return false
  const session = await findOpenSession({ organizationId, bindingId, channel: input.channel, threadTs: input.thread_ts })
  if (!session) return false

  const [sessionFlow, sessionRun] = await Promise.all([
    systemPrisma.flow.findFirst({
      where: { id: session.flowId, organizationId, status: 'ACTIVE' },
      select: { id: true, userId: true, organizationId: true, publishedGraph: true, trigger: true },
    }),
    systemPrisma.flowRun.findFirst({ where: { id: session.flowRunId, organizationId }, select: { status: true } }),
  ])
  const flowActive = Boolean(sessionFlow && sessionFlow.publishedGraph != null)
  const routing = resolveSessionRouting({ session, runStatus: sessionRun?.status ?? null, flowActive })
  if (!flowActive) {
    // Unpublished/deleted flow: the conversation is over — close and fall
    // through to normal matching.
    await closeSession({ organizationId, id: session.id })
    return false
  }
  if (routing.mode === 'fallthrough' || !sessionFlow) return false

  // Read-side re-gate: the session was opened while the flow's trigger had
  // threadMemory:true, but an operator may have since republished the flow
  // with threadMemory off (or removed). Re-check the CURRENT trigger — an
  // open session must not keep continuing a conversation the flow no longer
  // opts into. Close it and fall through to normal matching.
  if (slackTriggerConfigOf(sessionFlow.trigger)?.threadMemory !== true) {
    await closeSession({ organizationId, id: session.id })
    return false
  }

  const owner = await resolveRunOwner(sessionFlow)
  if (!owner) return false

  if (routing.mode === 'resume') {
    // The thread message answers the run's pending question — resume it
    // (the resumeKey machinery targets the paused iteration; the reply hook
    // re-fires on the resumed run's next settle). No new run.
    await dispatchFlowExecution({
      flowId: sessionFlow.id,
      organizationId,
      userId: owner.id,
      flowRunId: routing.flowRunId,
      reply: input.text,
      usePublished: true,
    }).catch((error) =>
      apiLogger.error('slack thread resume failed', { flowRunId: routing.flowRunId, error: error instanceof Error ? error.message : String(error) }),
    )
    return true
  }

  // routing.mode === 'continue': the prior run has settled — start a NEW run
  // continuing the conversation, seeded from the session's last agent
  // execution (if any).
  //
  // Double-delivery guard (mirrors the normal-match loop's per-flow claim
  // below): a reply that ALSO @mentions the bot fires two event_callbacks for
  // one physical message, and both reach tryThreadContinuation in
  // continue-mode. Claim a session-scoped, message-scoped key first — atomic
  // and DB-backed via the same SlackProcessedEvent unique constraint — so
  // only one delivery starts the new run; the sibling is dropped as handled.
  if (input.ts) {
    const claimed = await claimSlackEvent(bindingId, `msg:${input.channel}:${input.ts}:cont:${session.flowId}`)
    if (!claimed) return true
  }

  const result = await dispatchFlowExecution({
    flowId: sessionFlow.id,
    organizationId,
    userId: owner.id,
    input,
    usePublished: true,
    trigger: slackRunTrigger(bindingId, input),
    ...(routing.continueExecutionId ? { slackContinueExecutionId: routing.continueExecutionId } : {}),
  }).catch((error) => {
    apiLogger.error('slack thread continuation failed', { flowId: sessionFlow.id, error: error instanceof Error ? error.message : String(error) })
    return null
  })
  if (result) {
    // Best-effort — the run already dispatched; a bookkeeping-write failure
    // here must never escape and trigger an ingress release/retry (which
    // would double-dispatch since the claim above is already committed).
    await upsertThreadSession({
      organizationId,
      bindingId,
      channel: input.channel,
      threadTs: input.thread_ts,
      flowId: sessionFlow.id,
      flowRunId: result.flowRunId,
    }).catch((error) =>
      apiLogger.error('slack thread session upsert failed', { flowId: sessionFlow.id, error: error instanceof Error ? error.message : String(error) }),
    )
  }
  return true
}

/**
 * Route a verified, deduped, non-bot Slack event to matching flows and
 * dispatch each as its own PUBLISHED run. Runs inside after() — best-effort;
 * per-flow failures are logged, never thrown.
 */
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  const { bindingId, organizationId, normalized } = args
  const input = normalized.input

  // Observe every verified, deduped, non-bot event without delaying dispatch.
  const observed = slackActivityFromInput(input)
  if (observed) void ingestActivity(organizationId, 'webhook', [observed]).catch(() => undefined)

  // Ingress precedence: an open thread session takes priority over normal
  // trigger matching (see tryThreadContinuation). No thread_ts, or a thread
  // with no open session, falls through unchanged.
  if (await tryThreadContinuation({ bindingId, organizationId, input })) return

  // systemPrisma: session-less ingress continuation — org id came from the
  // binding row, and every query below is scoped to it.
  const flows = await systemPrisma.flow.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: { id: true, userId: true, organizationId: true, trigger: true, publishedGraph: true },
    take: 200,
  })
  const candidates = flows.filter((flow) => flow.publishedGraph != null)
  const matches = matchSlackFlows(input, candidates, bindingId)
  if (!matches.length) return

  for (const match of matches) {
    const flow = candidates.find((candidate) => candidate.id === match.id)
    if (!flow) continue

    // Double-delivery guard: an app subscribed to BOTH app_mention and
    // message.channels gets TWO event_callbacks — distinct event_ids — for
    // ONE physical Slack message. The ingress route's event-id dedup (claimed
    // before routeSlackEvent ever runs) does not catch this, since the ids
    // differ. Claim a second, message-scoped key per matched flow — atomic
    // and DB-backed via the same SlackProcessedEvent unique constraint
    // claimSlackEvent already uses — so a flow matching both sibling events
    // for the same (channel, ts) dispatches exactly once. Slash commands
    // carry no ts and are exempt: Slack delivers them once, with no sibling
    // event.
    if (input.ts) {
      const claimedMessage = await claimSlackEvent(bindingId, `msg:${input.channel}:${input.ts}:${flow.id}`)
      if (!claimedMessage) continue
    }

    try {
      const owner = await resolveRunOwner(flow)
      if (!owner) {
        apiLogger.warn('slack dispatch skipped — no active user to attribute the run to', { flowId: flow.id })
        continue
      }
      // Durable dispatch: the SAME path the webhook trigger uses
      // (dispatchFlowExecution) — queue mode enqueues onto BullMQ when
      // EXECUTION_MODE=queue, inline mode runs synchronously in dev/test.
      const result = await dispatchFlowExecution({
        flowId: flow.id,
        organizationId,
        userId: owner.id,
        input,
        usePublished: true,
        trigger: slackRunTrigger(bindingId, input),
      })
      await afterSlackDispatch({ organizationId, bindingId, input, config: match.config, flowId: flow.id, flowRunId: result.flowRunId })
    } catch (error) {
      apiLogger.error('slack flow dispatch failed', { flowId: flow.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Post-dispatch bookkeeping: a `threadMemory:true` flow opens (or refreshes)
 * a SlackThreadSession keyed to this thread, so a later reply in the SAME
 * thread routes as a continuation (see tryThreadContinuation) instead of
 * matching as a fresh trigger. A flow without threadMemory never creates a
 * session — its runs stay single-shot, unchanged from Task 5/6. Best-effort:
 * a session-write failure must never affect the run that already dispatched. */
async function afterSlackDispatch(args: {
  organizationId: string
  bindingId: string
  input: SlackTriggerInput
  config: SlackTriggerConfig
  flowId: string
  flowRunId: string
}): Promise<void> {
  if (!args.config.threadMemory) return
  const threadTs = args.input.thread_ts ?? (args.input.ts || undefined)
  if (!threadTs) return // slash commands have no thread to remember
  await upsertThreadSession({
    organizationId: args.organizationId,
    bindingId: args.bindingId,
    channel: args.input.channel,
    threadTs,
    flowId: args.flowId,
    flowRunId: args.flowRunId,
  }).catch((error) =>
    apiLogger.error('slack thread session upsert failed', { flowId: args.flowId, error: error instanceof Error ? error.message : String(error) }),
  )
}
