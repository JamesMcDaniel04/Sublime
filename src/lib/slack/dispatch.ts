import { apiLogger } from '@/lib/logger'
import type { NormalizedSlackEvent } from '@/lib/slack/payload'

export type SlackRouteArgs = {
  bindingId: string
  organizationId: string
  botUserId: string
  normalized: NormalizedSlackEvent
}

/**
 * Route a verified, deduped, non-bot Slack event to matching flows.
 * Runs inside after() — the HTTP ack has already gone out.
 * Task 5 implements matching + dispatch; this stub only logs.
 */
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  apiLogger.info('slack event received (routing not yet implemented)', {
    bindingId: args.bindingId,
    kind: args.normalized.input.kind,
  })
}
