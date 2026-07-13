/** Slack ActivitySource for normalized live events and historical messages. */
import type { SlackTriggerInput } from '@/lib/slack/payload'
import type { ActivitySource, BackfillBatch, BackfillWindow, NormalizedActivity, SourceContext } from '../types'

function tsToDate(ts: string): Date | null {
  const seconds = Number(ts)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

export function slackActivityFromInput(input: SlackTriggerInput): NormalizedActivity | null {
  if (input.kind === 'slash_command' || !input.ts) return null
  const occurredAt = tsToDate(input.ts)
  if (!occurredAt) return null
  return {
    source: 'slack',
    actorRef: input.user,
    action: input.thread_ts ? 'replied_in_thread' : 'posted_message',
    entityType: 'message',
    entityRef: `${input.channel}:${input.ts}`,
    entityName: input.channelName ?? null,
    businessContext: {
      channel: input.channel,
      ...(input.channelName ? { channelName: input.channelName } : {}),
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      team: input.team,
    },
    newState: { text: input.text.slice(0, 500) },
    occurredAt,
    dedupeKey: `slack:${input.channel}:${input.ts}`,
  }
}

export const slackActivitySource: ActivitySource = {
  source: 'slack',
  capabilities: { backfill: true, webhooks: true, incrementalSync: false },
  async *backfill(_ctx: SourceContext, _window: BackfillWindow, _cursor?: string): AsyncIterable<BackfillBatch> {
    return
  },
  async handleEvent(_ctx, payload) {
    const activity = slackActivityFromInput(payload as SlackTriggerInput)
    return activity ? [activity] : []
  },
  async incrementalSync() { return [] },
}
