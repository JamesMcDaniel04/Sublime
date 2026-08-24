/**
 * Who, in Sublime, is the person who typed this in Slack.
 *
 * This is a SECURITY resolution, not a display one. An agent run loads its
 * tools with the run's userId (execute-agent → loadTools), so the resolved
 * user decides whose personal connections the agent may reach. Falling back
 * to the agent's owner when the Slack user is unknown would let anyone in a
 * Slack channel drive an agent using the OWNER's credentials — so this
 * deliberately returns null instead, and the caller refuses the request.
 *
 * Resolution is by verified email: Slack's users.info returns the workspace
 * email (the `users:read` scope is already in our app manifest), and we match
 * it against an active member of the same organization.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cacheGet, cacheSet } from '@/lib/cache'

const SLACK_USERS_INFO_URL = 'https://slack.com/api/users.info'
/** Slack profiles change rarely; a short TTL keeps a busy channel off the API. */
const TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5000

const cacheKey = (organizationId: string, slackUserId: string) => `slackuser:${organizationId}:${slackUserId}`

export async function resolveSlackRequesterUserId(args: {
  organizationId: string
  botToken: string
  slackUserId: string
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const { organizationId, slackUserId } = args
  if (!slackUserId) return null

  const cached = await cacheGet<string>(cacheKey(organizationId, slackUserId)).catch(() => null)
  if (cached) return cached

  const email = await fetchSlackEmail(args)
  if (!email) return null

  // systemPrisma: the lookup IS the tenant resolution — organizationId is
  // supplied by the caller from the verified Slack binding, and the query is
  // scoped to it.
  const user = await systemPrisma.user.findFirst({
    where: {
      organizationId,
      isActive: true,
      email: { equals: email, mode: 'insensitive' },
    },
    select: { id: true },
  })
  if (!user) return null

  await cacheSet(cacheKey(organizationId, slackUserId), user.id, TTL_MS).catch(() => undefined)
  return user.id
}

async function fetchSlackEmail(args: {
  botToken: string
  slackUserId: string
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const fetchImpl = args.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${SLACK_USERS_INFO_URL}?user=${encodeURIComponent(args.slackUserId)}`, {
      headers: { Authorization: `Bearer ${args.botToken}` },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      ok?: boolean
      user?: { profile?: { email?: string } }
      error?: string
    }
    if (!payload.ok) {
      // `missing_scope` is the operator-actionable case: the app was installed
      // before users:read, so nobody in that workspace can address an agent.
      apiLogger.warn('slack users.info refused', { error: payload.error ?? 'unknown' })
      return null
    }
    return payload.user?.profile?.email?.trim().toLowerCase() || null
  } catch (error) {
    apiLogger.warn('slack users.info failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}
