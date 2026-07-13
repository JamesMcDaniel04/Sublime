/**
 * Slack REST API integration
 *
 * Exposes Slack message actions backed by the selected workspace connection.
 *
 * Requires: SLACK_BOT_TOKEN in the environment.
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage'

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function slackTools(): ToolDefinition[] {
  return [
    {
      name: 'post_message',
      description:
        'Post a message to a Slack channel. Supports mrkdwn fallback text, Block Kit blocks, attachments, and threaded replies.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' },
          blocks: { type: 'array', items: { type: 'object' } },
          attachments: { type: 'array', items: { type: 'object' } },
          thread_ts: { type: 'string' },
          reply_broadcast: { type: 'boolean' },
          unfurl_links: { type: 'boolean' },
          unfurl_media: { type: 'boolean' },
        },
        required: ['channel'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SlackToolClient
// ---------------------------------------------------------------------------

export class SlackToolClient {
  constructor(
    private readonly botToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // GranolaToolClient.executeTool, so the run loop's JSON.stringify(result)
  // wrapping is identical for all integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const token = this.botToken || process.env.SLACK_BOT_TOKEN
    if (!token) throw new Error('Slack bot token is not configured')

    if (name === 'post_message') {
      if (typeof args.channel !== 'string' || !args.channel.trim()) throw new Error('Slack post_message requires a channel')
      if (typeof args.text !== 'string' && !Array.isArray(args.blocks)) throw new Error('Slack post_message requires text or blocks')
      const payload = Object.fromEntries(
        ['channel', 'text', 'blocks', 'attachments', 'thread_ts', 'reply_broadcast', 'unfurl_links', 'unfurl_media']
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      )
      const response = await this.fetchImpl(SLACK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })

      // Slack always returns HTTP 200 even on failure; we must inspect body.ok
      const body = (await response.json()) as Record<string, unknown>
      if (body.ok !== true) {
        throw new Error(`Slack API error: ${body.error ?? 'unknown'}`)
      }

      return body
    }

    throw new Error(`Unknown Slack tool: ${name}`)
  }
}
