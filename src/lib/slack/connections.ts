/**
 * SlackWorkspaceConnection helpers: encrypted-at-rest secret storage (mirrors
 * the mcp-connections authConfig shape via secrets.ts), redacting serializer,
 * ingress URL, and the Slack auth.test verification call.
 */
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

const SLACK_AUTH_TEST_URL = 'https://slack.com/api/auth.test'

/** Storage shape for botToken / signingSecret Json columns. */
export function encryptSecretJson(plaintext: string): { value: string } {
  return { value: encryptSecret(plaintext) }
}

export function decryptSecretJson(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { value?: unknown }).value !== 'string') {
    throw new Error('Malformed encrypted Slack secret payload')
  }
  return decryptSecret((payload as { value: string }).value)
}

export function slackIngressUrl(bindingId: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return `${baseUrl}/api/slack/events/${bindingId}`
}

/**
 * Verify a bot token against Slack and capture the workspace identity.
 * Slack returns HTTP 200 even on failure — inspect body.ok. `user_id` on a
 * bot-token auth.test IS the bot's own user id (the echo-guard identity).
 */
export async function slackAuthTest(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ teamId: string; teamName: string | null; botUserId: string }> {
  const response = await fetchImpl(SLACK_AUTH_TEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack auth.test failed: ${body.error ?? 'unknown'}`)
  const teamId = typeof body.team_id === 'string' ? body.team_id : ''
  const botUserId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!teamId || !botUserId) throw new Error('Slack auth.test failed: missing team_id/user_id')
  return { teamId, teamName: typeof body.team === 'string' ? body.team : null, botUserId }
}

/** Redacted API view — secrets are NEVER included. */
export function serializeSlackConnection(row: {
  id: string
  organizationId?: string
  teamId: string
  teamName: string | null
  botUserId: string
  botToken: unknown
  signingSecret: unknown
  status: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    status: row.status,
    hasBotToken: Boolean((row.botToken as { value?: unknown } | null)?.value),
    hasSigningSecret: Boolean((row.signingSecret as { value?: unknown } | null)?.value),
    ingressUrl: slackIngressUrl(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
