import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { matchSlackFlows, slackTriggerConfigOf, type SlackTriggerConfig } from '@/lib/slack/route-event'
import { claimSlackEvent } from '@/lib/slack/dedup'
import { findOpenSession, resolveSessionRouting, resolveAgentSessionRouting, upsertThreadSession, upsertAgentThreadSession, closeSession } from '@/lib/slack/session'
import { resumeAgentExecution } from '@/features/agents/execute-agent'
import { encryptRunText } from '@/lib/agents/run-crypto'
import type { NormalizedSlackEvent, SlackTriggerInput } from '@/lib/slack/payload'
import { ingestActivity } from '@/lib/activity/ingest'
import { slackActivityFromInput } from '@/lib/activity/sources/slack'
import { resolveAgentMention } from '@/lib/slack/route-agent'
import { resolveSlackRequesterUserId } from '@/lib/slack/requester'
import { decryptSecretJson } from '@/lib/slack/connections'
import { postSlackMessage } from '@/lib/slack/post'
import { agentDisplayName } from '@/lib/agents/metadata'
import { createAgentRequest } from '@/lib/agents/request-dispatch'

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
 * A message in a thread an agent conversation owns.
 *
 * Two outcomes, decided by resolveAgentSessionRouting: the message ANSWERS a
 * question the run is parked on, or it is a FOLLOW-UP ask after the request
 * settled. Both resolve the Slack user to a member first — the same
 * no-fallback rule as the initial ask, because a resumed run keeps executing
 * with the requester's credentials and a follow-up runs with the replier's.
 *
 * Only the person who asked may answer the agent's question. The run holds
 * THEIR connections; letting anyone in the channel steer it would be an
 * escalation the initial identity check exists to prevent.
 */
async function tryAgentThreadContinuation(args: {
  bindingId: string
  organizationId: string
  input: SlackTriggerInput
  session: { id: string; threadTs: string; agentTaskId: string | null; agentRequestId: string | null; agentExecutionId: string | null; status: string }
}): Promise<boolean> {
  const { bindingId, organizationId, input, session } = args
  const request = session.agentRequestId
    ? await systemPrisma.agentRequest.findFirst({
        where: { id: session.agentRequestId, organizationId },
        select: {
          id: true,
          status: true,
          executionId: true,
          agentTaskId: true,
          requestedByUserId: true,
          agentTask: { select: { id: true, status: true, agentType: true, description: true, metadata: true, visibility: true, userId: true } },
        },
      })
    : null
  const execution = request?.executionId
    ? await systemPrisma.agentExecution.findFirst({ where: { id: request.executionId, organizationId }, select: { status: true } })
    : null
  const routing = resolveAgentSessionRouting({
    session,
    requestStatus: request?.status ?? null,
    executionStatus: execution?.status ?? null,
    agentActive: request?.agentTask.status === 'ACTIVE',
  })
  if (!request || request.agentTask.status !== 'ACTIVE') {
    await closeSession({ organizationId, id: session.id })
    return false
  }
  if (routing.mode === 'fallthrough') return false

  const binding = await systemPrisma.slackWorkspaceConnection.findFirst({
    where: { id: bindingId, organizationId, status: 'active' },
  })
  if (!binding) return false
  const botToken = decryptSecretJson(binding.botToken)
  const say = (text: string) =>
    postSlackMessage({ botToken, channel: input.channel, threadTs: session.threadTs, text }).catch(() => undefined)

  const replierUserId = await resolveSlackRequesterUserId({ organizationId, botToken, slackUserId: input.user ?? '' })
  if (!replierUserId) {
    await say("I couldn't match your Slack account to a Sublime user, so I can't act on this. Ask an admin to check that your Sublime account uses the same email as your Slack profile.")
    return true
  }

  // Double-delivery guard, as everywhere else on this ingress.
  if (input.ts) {
    const claimed = await claimSlackEvent(bindingId, `msg:${input.channel}:${input.ts}:agentcont:${request.id}`)
    if (!claimed) return true
  }

  if (routing.mode === 'resume') {
    if (replierUserId !== request.requestedByUserId) {
      await say(`Only the person who asked can answer this — the run is using their connections.`)
      return true
    }
    // systemPrisma: id-keyed write; the execution was loaded org-scoped above.
    await systemPrisma.executionMessage.create({
      data: { executionId: routing.executionId, role: 'user', content: encryptRunText(input.text) },
    })
    try {
      await resumeAgentExecution({
        executionId: routing.executionId,
        agentId: request.agentTaskId,
        organizationId,
        userId: request.requestedByUserId!,
        reply: input.text,
      })
    } catch (error) {
      apiLogger.error('slack agent resume failed', { requestId: request.id, error: error instanceof Error ? error.message : String(error) })
      await say(':warning: I couldn\'t resume that run just now. Please try again shortly.')
    }
    return true
  }

  // Follow-up: a new ask to the same agent, as the replier. Visibility rules
  // match the initial ask — a private agent answers only its owner.
  if (request.agentTask.visibility === 'private' && request.agentTask.userId !== replierUserId) return false
  const origin = { ...slackRunTrigger(bindingId, input).slack, thread_ts: session.threadTs }
  try {
    const created = await createAgentRequest({
      organizationId,
      requestedByUserId: replierUserId,
      agent: request.agentTask,
      text: input.text,
      origin: 'slack',
      slack: origin,
      continueExecutionId: routing.continueExecutionId,
    })
    await upsertAgentThreadSession({
      organizationId,
      bindingId,
      channel: input.channel,
      threadTs: session.threadTs,
      agentTaskId: request.agentTaskId,
      agentRequestId: created.requestId,
      agentExecutionId: created.executionId,
    }).catch(() => undefined)
  } catch (error) {
    apiLogger.error('slack agent follow-up dispatch failed', { agentId: request.agentTaskId, error: error instanceof Error ? error.message : String(error) })
    await say(':warning: I couldn\'t start that request just now. Please try again shortly.')
  }
  return true
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

  // A thread owned by an agent conversation routes to that agent.
  if (session.agentRequestId) return tryAgentThreadContinuation({ bindingId, organizationId, input, session })
  // A flow conversation needs both pointers; a row with neither owner is dead.
  if (!session.flowId || !session.flowRunId) {
    await closeSession({ organizationId, id: session.id })
    return false
  }
  const flowSession = { ...session, flowId: session.flowId, flowRunId: session.flowRunId }

  const [sessionFlow, sessionRun] = await Promise.all([
    systemPrisma.flow.findFirst({
      where: { id: flowSession.flowId, organizationId, status: 'ACTIVE' },
      select: { id: true, userId: true, organizationId: true, isPublished: true, trigger: true },
    }),
    systemPrisma.flowRun.findFirst({ where: { id: flowSession.flowRunId, organizationId }, select: { status: true } }),
  ])
  const flowActive = Boolean(sessionFlow?.isPublished)
  const routing = resolveSessionRouting({ session: flowSession, runStatus: sessionRun?.status ?? null, flowActive })
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
    const claimed = await claimSlackEvent(bindingId, `msg:${input.channel}:${input.ts}:cont:${flowSession.flowId}`)
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
 * Ingress precedence #2: an explicit agent address (`@Riley …`, `Riley: …`,
 * `ask Riley …`) routes to that agent instead of to flow triggers.
 *
 * Runs BEFORE flow matching but only ever fires on an explicit marker
 * (see route-agent.ts), so a message that does not address an agent by name
 * falls through with flow behavior completely unchanged.
 *
 * Work ordering is deliberate: agent names are matched from a cheap indexed
 * query FIRST, and the Slack users.info round-trip happens only once a
 * mention has actually matched. A busy channel must not pay an API call per
 * message.
 *
 * Returns true when the event was fully handled.
 */
async function tryAgentMention(args: {
  bindingId: string
  organizationId: string
  input: SlackTriggerInput
}): Promise<boolean> {
  const { bindingId, organizationId, input } = args
  const text = input.text ?? ''
  if (!text.trim()) return false

  // systemPrisma: session-less ingress; org id came from the verified binding
  // and every query below is scoped to it.
  const agents = await systemPrisma.agentTask.findMany({
    where: { organizationId, status: 'ACTIVE', agentType: { not: 'SYSTEM' } },
    select: { id: true, description: true, metadata: true, userId: true, visibility: true, agentType: true },
    take: 500,
  })
  if (!agents.length) return false

  const hit = resolveAgentMention(
    text,
    agents.map((agent) => ({ id: agent.id, name: agentDisplayName(agent) })),
  )
  if (!hit) return false

  const agent = agents.find((candidate) => candidate.id === hit.agentId)
  if (!agent) return false

  const binding = await systemPrisma.slackWorkspaceConnection.findFirst({
    where: { id: bindingId, organizationId, status: 'active' },
  })
  if (!binding) return false
  const botToken = decryptSecretJson(binding.botToken)

  // Double-delivery guard, mirroring the per-flow claim below: one physical
  // message can arrive as both app_mention and message.channels.
  if (input.ts) {
    const claimed = await claimSlackEvent(bindingId, `msg:${input.channel}:${input.ts}:agent:${agent.id}`)
    if (!claimed) return true
  }

  const origin = slackRunTrigger(bindingId, input).slack

  // SECURITY: the resolved user decides whose credentials the run may reach
  // (execute-agent loads tools with the run's userId). There is deliberately
  // NO fallback to the agent's owner — that would let anyone in a Slack
  // channel drive an agent using the owner's connected accounts.
  const requesterUserId = await resolveSlackRequesterUserId({
    organizationId,
    botToken,
    slackUserId: input.user ?? '',
  })
  if (!requesterUserId) {
    await postSlackMessage({
      botToken,
      channel: input.channel,
      threadTs: origin.thread_ts,
      text: "I couldn't match your Slack account to a Sublime user, so I can't run this on your behalf. Ask an admin to check that your Sublime account uses the same email as your Slack profile.",
    }).catch(() => undefined)
    return true
  }

  // Visibility is honored exactly as the in-app route honors it: a private
  // agent is addressable only by its owner. A name the requester may not
  // address falls THROUGH rather than replying, so the response is
  // indistinguishable from "no agent by that name".
  if (agent.visibility === 'private' && agent.userId !== requesterUserId) return false

  try {
    const created = await createAgentRequest({
      organizationId,
      requestedByUserId: requesterUserId,
      agent,
      text: hit.text,
      origin: 'slack',
      slack: origin,
    })
    // The thread now belongs to this conversation: a reply answers the agent's
    // question, a later message is a follow-up ask. Best-effort — the request
    // is already dispatched, and a session write failing must not retry it.
    if (origin.thread_ts) {
      await upsertAgentThreadSession({
        organizationId,
        bindingId,
        channel: input.channel,
        threadTs: origin.thread_ts,
        agentTaskId: agent.id,
        agentRequestId: created.requestId,
        agentExecutionId: created.executionId,
      }).catch((error) =>
        apiLogger.error('slack agent session upsert failed', { requestId: created.requestId, error: error instanceof Error ? error.message : String(error) }),
      )
    }
  } catch (error) {
    apiLogger.error('slack agent request dispatch failed', {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    })
    await postSlackMessage({
      botToken,
      channel: input.channel,
      threadTs: origin.thread_ts,
      text: `:warning: I couldn't start that request just now. Please try again shortly.`,
    }).catch(() => undefined)
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

  // Ingress precedence #2: an explicit agent address wins over flow trigger
  // matching. Only fires on `@Name` / `Name:` / `ask Name`, so nothing that
  // matched a flow before matches an agent now.
  if (await tryAgentMention({ bindingId, organizationId, input })) return

  // systemPrisma: session-less ingress continuation — org id came from the
  // binding row, and every query below is scoped to it.
  // Indexed narrowing on the denormalized columns: only published,
  // slack-triggered flows are loaded (trigger JSON only) — Slack ingress is
  // event-rate-driven, and this previously pulled every active flow's full
  // publishedGraph per message in a busy workspace.
  const candidates = await systemPrisma.flow.findMany({
    where: { organizationId, status: 'ACTIVE', triggerType: 'slack', isPublished: true },
    select: { id: true, userId: true, organizationId: true, trigger: true },
    take: 200,
  })
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
