/**
 * Slack REST API integration
 *
 * Exposes one agent tool — post_message — that lets agents post messages to a
 * Slack channel during a run.
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
        'Post a message to a Slack channel. `channel` is a channel id or name (e.g. "#revenue" or "C012AB3CD"); `text` supports Slack mrkdwn.',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channel', 'text'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SlackToolClient
// ---------------------------------------------------------------------------

export class SlackToolClient {
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
    const token = process.env.SLACK_BOT_TOKEN
    if (!token) throw new Error('Slack bot token is not configured')

    if (name === 'post_message') {
      const response = await fetch(SLACK_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: args.channel,
          text: args.text,
        }),
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
