/**
 * Slack payload normalization (pure, CLIENT-SAFE — no node imports; the
 * builder UI imports SLACK_EVENT_KINDS). Both event callbacks and slash
 * commands map to one SlackTriggerInput, exposed to the flow as
 * {{trigger.input.text}}, {{trigger.input.channel}}, etc.
 */
export const SLACK_EVENT_KINDS = ['app_mention', 'message.im', 'message.channels', 'slash_command'] as const
export type SlackEventKind = (typeof SLACK_EVENT_KINDS)[number]

export type SlackTriggerInput = {
  kind: SlackEventKind
  text: string
  user: string
  channel: string
  channelName?: string
  ts: string
  thread_ts?: string
  team: string
  command?: string
  response_url?: string
  permalink?: string
}

export type NormalizedSlackEvent = {
  input: SlackTriggerInput
  /** event_id (events) / trigger_id (commands) — the 10-minute dedup key. */
  dedupId: string
  /** Present when a bot authored the message — the echo guard drops these. */
  authorBotId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function normalizeSlackEventPayload(envelope: unknown): NormalizedSlackEvent | null {
  if (!isRecord(envelope) || envelope.type !== 'event_callback' || !isRecord(envelope.event)) return null
  const event = envelope.event
  // Subtyped messages (message_changed, message_deleted, channel_join, …) are
  // edits/noise, never fresh input. Bot messages arrive subtype-less with
  // bot_id set — normalized through so the route's echo guard owns the drop.
  if (typeof event.subtype === 'string') return null
  let kind: SlackEventKind | null = null
  if (event.type === 'app_mention') kind = 'app_mention'
  else if (event.type === 'message' && event.channel_type === 'im') kind = 'message.im'
  else if (event.type === 'message' && event.channel_type === 'channel') kind = 'message.channels'
  if (!kind) return null // v1: no mpim/group support
  const dedupId = str(envelope.event_id)
  if (!dedupId) return null
  return {
    input: {
      kind,
      text: str(event.text),
      user: str(event.user),
      channel: str(event.channel),
      ts: str(event.ts),
      ...(str(event.thread_ts) ? { thread_ts: str(event.thread_ts) } : {}),
      team: str(envelope.team_id),
    },
    dedupId,
    ...(str(event.bot_id) ? { authorBotId: str(event.bot_id) } : {}),
  }
}

export function normalizeSlackCommandPayload(params: Record<string, string>): NormalizedSlackEvent | null {
  if (!params.command || !params.trigger_id) return null
  return {
    input: {
      kind: 'slash_command',
      text: params.text ?? '',
      user: params.user_id ?? '',
      channel: params.channel_id ?? '',
      ...(params.channel_name ? { channelName: params.channel_name } : {}),
      ts: '', // slash commands carry no message ts — replies use response_url
      team: params.team_id ?? '',
      command: params.command,
      ...(params.response_url ? { response_url: params.response_url } : {}),
    },
    dedupId: params.trigger_id,
  }
}
