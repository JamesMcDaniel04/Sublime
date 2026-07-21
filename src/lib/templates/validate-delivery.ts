/**
 * Deploy-time delivery-target validation. A 1-click deploy that silently
 * posts into a channel that doesn't exist (or that the bot can't post to) is
 * a silent failure discovered days later — check at provision time and hand
 * the caller a human-readable warning instead. Best-effort by design: no
 * Slack workspace connection, or a Slack API failure, means "can't validate",
 * never a blocked deploy.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecretJson } from '@/lib/slack/connections'
import { listSlackChannels } from '@/lib/slack/api'

export type DeliveryValidation = { ok: boolean; warning?: string }

export async function validateSlackDeliveryChannel(
  organizationId: string,
  channel: string,
  deps: { listChannels?: typeof listSlackChannels } = {},
): Promise<DeliveryValidation> {
  const name = channel.replace(/^#/, '').trim().toLowerCase()
  if (!name) return { ok: true }
  try {
    const connection = await prisma.slackWorkspaceConnection.findFirst({
      where: { organizationId, status: 'active' },
      select: { botToken: true },
    })
    // No workspace app installed — delivery may run through a Nango Slack
    // connection this helper can't enumerate. Nothing to validate against.
    if (!connection) return { ok: true }
    const channels = await (deps.listChannels ?? listSlackChannels)(decryptSecretJson(connection.botToken))
    const match = channels.find((c) => c.name.toLowerCase() === name)
    if (!match) {
      return { ok: false, warning: `Slack channel #${name} was not found in your workspace — open the flow's delivery step and pick a real channel.` }
    }
    if (!match.isMember) {
      return { ok: false, warning: `The Sublime app is not in #${name} — invite it (/invite) or pick another channel, or delivery will fail.` }
    }
    return { ok: true }
  } catch (error) {
    apiLogger.warn('validateSlackDeliveryChannel: skipped (Slack API unavailable)', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
    return { ok: true }
  }
}
