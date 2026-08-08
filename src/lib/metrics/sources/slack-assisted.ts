/**
 * Slack assisted metric source (`source: 'slack_assisted'`, key
 * `assisted.value`). Reads recent channel messages and extracts the latest
 * stated value with the cheap summary model. Readings persist with origin
 * 'assisted' and wear the AI-read badge — never presented as exact.
 *
 * Resolves only the acting user's encrypted Slack workspace connection.
 */
import { prisma } from '@/lib/prisma'
import { decryptSecretJson } from '@/lib/slack/connections'
import { listSlackChannels } from '@/lib/slack/api'
import { extractMetricReading } from '../assisted-extraction'
import type { generateStructured } from '@/lib/llm/model-runner'
import type {
  MetricDescriptor,
  MetricReading,
  MetricSource,
  MetricSourceContext,
} from '../types'

const SLACK_API = 'https://slack.com/api'
const HISTORY_LIMIT = 50
const WINDOW_DAYS = 7

const METRICS: MetricDescriptor[] = [
  { key: 'assisted.value', label: 'AI-read from a Slack channel', unit: 'count' },
]

export function makeSlackAssistedMetricSource(deps?: {
  fetchImpl?: typeof fetch
  listChannels?: typeof listSlackChannels
  generate?: typeof generateStructured
  tokenFor?: (organizationId: string, userId: string) => Promise<string | null>
}): MetricSource {
  const fetchImpl = deps?.fetchImpl ?? fetch
  const listChannels = deps?.listChannels ?? listSlackChannels
  return {
    source: 'slack_assisted',
    availableMetrics: () => METRICS,
    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      if (metricKey !== 'assisted.value') throw new Error(`Unknown metric '${metricKey}'`)
      if (!ctx.userId) throw new Error('Slack metrics require the user who owns the connection.')
      const token = deps?.tokenFor
        ? await deps.tokenFor(ctx.organizationId, ctx.userId)
        : await personalSlackToken(ctx.organizationId, ctx.userId)
      if (!token) throw new Error('Slack is not connected for your account.')
      const rawChannel = typeof ctx.config.channel === 'string' ? ctx.config.channel.trim() : ''
      if (!rawChannel) throw new Error('Pick the Slack channel that reports this number.')

      // Accept a channel id directly; resolve '#name' / 'name' via the roster.
      let channelId = rawChannel
      if (!/^[CG][A-Z0-9]{6,}$/.test(rawChannel)) {
        const name = rawChannel.replace(/^#/, '').toLowerCase()
        const channel = (await listChannels(token, fetchImpl)).find(
          (candidate) => candidate.name.toLowerCase() === name,
        )
        if (!channel) throw new Error(`Slack channel #${name} was not found (is the bot a member?).`)
        channelId = channel.id
      }

      const oldest = (Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000
      const url = new URL(`${SLACK_API}/conversations.history`)
      url.searchParams.set('channel', channelId)
      url.searchParams.set('limit', String(HISTORY_LIMIT))
      url.searchParams.set('oldest', String(oldest))
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await response.json()) as {
        ok?: boolean
        error?: string
        messages?: Array<{ text?: string; ts?: string }>
      }
      if (body.ok !== true) throw new Error(`Slack history failed: ${body.error ?? 'unknown'}`)

      const corpus = (body.messages ?? [])
        .flatMap((message) => (typeof message.text === 'string' && message.text.trim() ? [message.text] : []))
        .join('\n')
      const reading = await extractMetricReading({
        goalName: typeof ctx.config.metricHint === 'string' ? ctx.config.metricHint : '',
        metricHint: typeof ctx.config.metricHint === 'string' ? ctx.config.metricHint : undefined,
        sourceLabel: `#${rawChannel.replace(/^#/, '')}`,
        corpus,
        organizationId: ctx.organizationId,
        generate: deps?.generate,
      })
      return { value: reading.value, asOf: new Date() }
    },
  }
}

async function personalSlackToken(organizationId: string, userId: string): Promise<string | null> {
  const binding = await prisma.slackWorkspaceConnection.findFirst({
    where: { organizationId, userId, status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  if (!binding) return null
  try {
    return decryptSecretJson(binding.botToken)
  } catch {
    return null
  }
}

export const slackAssistedMetricSource = makeSlackAssistedMetricSource()
