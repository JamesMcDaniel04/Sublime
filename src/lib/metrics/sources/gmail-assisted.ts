/**
 * Gmail assisted metric source (`source: 'gmail_assisted'`, key
 * `assisted.value`). Runs a Gmail search through the native Google
 * connection, reads the top matches, and extracts the latest stated value
 * with the cheap summary model. Same never-fabricate contract as Slack.
 */
import { googleProxy } from '@/lib/google/proxy'
import type { NangoProxy } from '@/lib/nango/delivery'
import { extractMetricReading } from '../assisted-extraction'
import type { generateStructured } from '@/lib/llm/model-runner'
import type {
  MetricDescriptor,
  MetricReading,
  MetricSource,
  MetricSourceContext,
} from '../types'
import { refId } from '../types'

const MAX_MESSAGES = 5
const MAX_BODY_CHARS = 4_000

const METRICS: MetricDescriptor[] = [
  { key: 'assisted.value', label: 'AI-read from report emails', unit: 'count' },
]

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }

/** Prefer text/plain parts; fall back to tag-stripped HTML. */
export function extractMessageText(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const chunks: string[] = []
  const queue: GmailPart[] = [payload]
  while (queue.length > 0) {
    const part = queue.shift()!
    if (part.body?.data && (part.mimeType?.startsWith('text/') || !part.mimeType)) {
      const decoded = decodeBase64Url(part.body.data)
      chunks.push(part.mimeType === 'text/html' ? decoded.replace(/<[^>]+>/g, ' ') : decoded)
    }
    if (part.parts) queue.push(...part.parts)
  }
  return chunks.join('\n').replace(/\s{3,}/g, ' ').slice(0, MAX_BODY_CHARS)
}

export function makeGmailAssistedMetricSource(deps?: {
  proxyFor?: (ref: { organizationId: string; connectionId: string }) => NangoProxy
  generate?: typeof generateStructured
}): MetricSource {
  return {
    source: 'gmail_assisted',
    availableMetrics: () => METRICS,
    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      if (metricKey !== 'assisted.value') throw new Error(`Unknown metric '${metricKey}'`)
      const query = typeof ctx.config.query === 'string' ? ctx.config.query.trim() : ''
      if (!query) throw new Error('Enter the Gmail search that finds the report emails.')
      const connectionId = refId(ctx.connectionRef, 'google')
      const proxy = (deps?.proxyFor ?? googleProxy)({
        organizationId: ctx.organizationId,
        connectionId,
      })
      const connection = {
        connectionId,
        providerConfigKey: 'google-mail',
        provider: 'google-native',
        organizationId: ctx.organizationId,
        scope: 'org' as const,
      }

      const list = await proxy({
        method: 'GET',
        endpoint: '/gmail/v1/users/me/messages',
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { q: query, maxResults: MAX_MESSAGES },
      })
      const ids = ((list.data as { messages?: Array<{ id?: string }> }).messages ?? [])
        .flatMap((message) => (typeof message.id === 'string' ? [message.id] : []))
        .slice(0, MAX_MESSAGES)
      if (ids.length === 0) {
        throw new Error(`No emails matched "${query}" — widen the search or check the mailbox.`)
      }

      const bodies: string[] = []
      for (const id of ids) {
        const message = await proxy({
          method: 'GET',
          endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
          connectionId: connection.connectionId,
          providerConfigKey: connection.providerConfigKey,
          params: { format: 'full' },
        })
        const data = message.data as { snippet?: string; payload?: GmailPart }
        const text = extractMessageText(data.payload) || data.snippet || ''
        if (text) bodies.push(text)
      }

      const reading = await extractMetricReading({
        goalName: typeof ctx.config.metricHint === 'string' ? ctx.config.metricHint : '',
        metricHint: typeof ctx.config.metricHint === 'string' ? ctx.config.metricHint : undefined,
        sourceLabel: `Gmail (“${query}”)`,
        corpus: bodies.join('\n---\n'),
        generate: deps?.generate,
      })
      return { value: reading.value, asOf: new Date() }
    },
  }
}

export const gmailAssistedMetricSource = makeGmailAssistedMetricSource()
