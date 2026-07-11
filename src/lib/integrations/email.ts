/**
 * Email integration via Resend REST API
 *
 * Exposes one agent tool — send — that lets agents send emails during a run.
 *
 * Requires: RESEND_API_KEY in the environment.
 * Optional: EMAIL_FROM (defaults to "Sublime <onboarding@resend.dev>").
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'

const RESEND_API_URL = 'https://api.resend.com/emails'

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function emailTools(): ToolDefinition[] {
  return [
    {
      name: 'send',
      description: 'Send an email to one recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'email body — HTML (preferred) or plain text' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// EmailToolClient
// ---------------------------------------------------------------------------

export class EmailToolClient {
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
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) throw new Error('Resend API key is not configured')

    if (name === 'send') {
      const from = process.env.EMAIL_FROM || 'Sublime <onboarding@resend.dev>'
      const body = typeof args.body === 'string' ? args.body : String(args.body ?? '')

      // Agents are instructed to compose HTML email bodies; send those as html
      // (with a tag-stripped plain-text fallback for non-HTML clients). A plain
      // body still sends as text, so this stays correct either way.
      const looksHtml = /<[a-z][\s\S]*>/i.test(body)
      const payload: Record<string, unknown> = { from, to: [args.to], subject: args.subject }
      if (looksHtml) {
        payload.html = body
        payload.text = body.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
      } else {
        payload.text = body
      }

      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        throw new Error(`Email API error ${response.status}`)
      }

      return response.json() as Promise<unknown>
    }

    throw new Error(`Unknown Email tool: ${name}`)
  }
}
