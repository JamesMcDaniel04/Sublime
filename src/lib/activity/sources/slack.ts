/** Slack ActivitySource for normalized live events and historical messages. */
import type { SlackTriggerInput } from '@/lib/slack/payload'
import { prisma } from '@/lib/prisma'
import { decryptSecretJson } from '@/lib/slack/connections'
import { windowStart, type ActivitySource, type NormalizedActivity } from '../types'

const SLACK_API = 'https://slack.com/api'
const PAGE_SIZE = 200

type SlackCursor = { channels: string[]; channelIndex: number; pageCursor?: string }

async function slackGet(botToken: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${SLACK_API}/${method}?${query}`, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack API error (${method}): ${body.error ?? 'unknown'}`)
  return body
}

function messageActivity(channel: string, message: Record<string, unknown>): NormalizedActivity | null {
  const ts = typeof message.ts === 'string' ? message.ts : ''
  const user = typeof message.user === 'string' ? message.user : ''
  if (!ts || !user || typeof message.subtype === 'string' || message.bot_id) return null
  const seconds = Number(ts)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const threadTs = typeof message.thread_ts === 'string' && message.thread_ts !== ts ? message.thread_ts : undefined
  return {
    source: 'slack',
    actorRef: user,
    action: threadTs ? 'replied_in_thread' : 'posted_message',
    entityType: 'message',
    entityRef: `${channel}:${ts}`,
    businessContext: { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
    newState: { text: String(message.text ?? '').slice(0, 500) },
    occurredAt: new Date(seconds * 1000),
    dedupeKey: `slack:${channel}:${ts}`,
  }
}

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
  async *backfill(ctx, window, cursor) {
    const connection = await prisma.slackWorkspaceConnection.findFirst({
      where: { id: ctx.connectionRef, organizationId: ctx.organizationId, status: 'active' },
    })
    if (!connection) return
    const botToken = decryptSecretJson(connection.botToken)
    const oldest = windowStart(window, new Date())

    let state: SlackCursor
    if (cursor) {
      state = JSON.parse(cursor) as SlackCursor
    } else {
      const channels: string[] = []
      let listCursor = ''
      do {
        const body = await slackGet(botToken, 'users.conversations', {
          types: 'public_channel', limit: '200', ...(listCursor ? { cursor: listCursor } : {}),
        })
        for (const channel of (body.channels as Array<{ id: string }> | undefined) ?? []) channels.push(channel.id)
        listCursor = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '')
      } while (listCursor)
      state = { channels, channelIndex: 0 }
    }

    while (state.channelIndex < state.channels.length) {
      const channel = state.channels[state.channelIndex]
      const body = await slackGet(botToken, 'conversations.history', {
        channel,
        limit: String(PAGE_SIZE),
        ...(oldest ? { oldest: String(oldest.getTime() / 1000) } : {}),
        ...(state.pageCursor ? { cursor: state.pageCursor } : {}),
      })
      const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
      const events = messages.map((message) => messageActivity(channel, message)).filter((event): event is NormalizedActivity => event !== null)
      const nextPage = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '')
      const next: SlackCursor = nextPage
        ? { ...state, pageCursor: nextPage }
        : { channels: state.channels, channelIndex: state.channelIndex + 1 }
      const exhausted = !nextPage && next.channelIndex >= state.channels.length
      yield { events, ...(exhausted ? {} : { nextCursor: JSON.stringify(next) }) }
      state = next
    }
  },
  async handleEvent(_ctx, payload) {
    const activity = slackActivityFromInput(payload as SlackTriggerInput)
    return activity ? [activity] : []
  },
  async incrementalSync() { return [] },
}
