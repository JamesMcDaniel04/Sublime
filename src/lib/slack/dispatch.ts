import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { matchSlackFlows, type SlackTriggerConfig } from '@/lib/slack/route-event'
import { claimSlackEvent } from '@/lib/slack/dedup'
import type { NormalizedSlackEvent, SlackTriggerInput } from '@/lib/slack/payload'

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
 * Route a verified, deduped, non-bot Slack event to matching flows and
 * dispatch each as its own PUBLISHED run. Runs inside after() — best-effort;
 * per-flow failures are logged, never thrown.
 */
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  const { bindingId, organizationId, normalized } = args
  const input = normalized.input

  // systemPrisma: session-less ingress continuation — org id came from the
  // binding row, and every query below is scoped to it.
  const flows = await systemPrisma.flow.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: { id: true, userId: true, organizationId: true, trigger: true, publishedGraph: true },
    take: 200,
  })
  const candidates = flows.filter((flow) => flow.publishedGraph != null)
  const matches = matchSlackFlows(input, candidates)
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

/** Post-dispatch bookkeeping. Task 7 fills this in with thread-session upkeep;
 * until then it is a no-op so Task 5 ships without the session model in play. */
async function afterSlackDispatch(_args: {
  organizationId: string
  bindingId: string
  input: SlackTriggerInput
  config: SlackTriggerConfig
  flowId: string
  flowRunId: string
}): Promise<void> {}
