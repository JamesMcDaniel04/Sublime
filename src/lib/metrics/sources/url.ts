/**
 * URL metric source — deterministic fetch + parse (`source: 'url'`, key
 * `url.value`). config: { url, jsonPath? }.
 *
 * SSRF is the threat model: this fetch runs server-side on infrastructure
 * that shares a network with Redis and internal services, and the URL is
 * user-supplied. assertSafeUrl rejects anything that could reach an internal
 * surface, and every redirect hop is re-validated (max 3).
 */
import { parseSheetNumber } from './google-sheets'
import type {
  MetricDescriptor,
  MetricReading,
  MetricSource,
  MetricSourceContext,
} from '../types'

const TIMEOUT_MS = 10_000
const MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 3

const METRICS: MetricDescriptor[] = [
  { key: 'url.value', label: 'Number from a URL', unit: 'count' },
]

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  const [a, b] = [Number(match[1]), Number(match[2])]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isPrivateIpv4(host)) return true
  // IPv6: loopback, unspecified, ULA fc00::/7, link-local fe80::/10, and
  // v4-mapped forms carrying a private v4.
  if (host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true
  // URL normalization rewrites v4-mapped addresses into hex form
  // (::ffff:10.0.0.1 → ::ffff:a00:1), so range-checking the dotted quad is
  // unreliable — reject the whole mapped class; public targets have no
  // legitimate reason to use it.
  if (/^::ffff:/i.test(host)) return true
  return false
}

/** Pure and exported for the test matrix. Throws with actionable copy. */
export function assertSafeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter a valid http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be tracked.')
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed.')
  }
  if (isForbiddenHost(url.hostname)) {
    throw new Error('Internal and private-network URLs cannot be tracked.')
  }
  return url
}

/** Breadth-first first numeric leaf; dot-path when given ('data.mrr.current'). */
export function extractJsonNumber(body: unknown, jsonPath?: string): number | null {
  if (jsonPath) {
    let cursor: unknown = body
    for (const segment of jsonPath.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return null
      cursor = (cursor as Record<string, unknown>)[segment]
    }
    return parseSheetNumber([[cursor]])
  }
  const queue: unknown[] = [body]
  while (queue.length > 0) {
    const value = queue.shift()
    const parsed = parseSheetNumber([[value]])
    if (parsed !== null && typeof value !== 'boolean') return parsed
    if (value && typeof value === 'object') {
      queue.push(...(Array.isArray(value) ? value : Object.values(value)))
    }
  }
  return null
}

export function extractTextNumber(body: string): number | null {
  const match = /-?\$?\d[\d,]*(?:\.\d+)?%?/.exec(body)
  return match ? parseSheetNumber([[match[0]]]) : null
}

export function makeUrlMetricSource(fetchImpl: typeof fetch = fetch): MetricSource {
  return {
    source: 'url',
    availableMetrics: () => METRICS,
    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      if (metricKey !== 'url.value') throw new Error(`Unknown URL metric '${metricKey}'`)
      const rawUrl = typeof ctx.config.url === 'string' ? ctx.config.url : ''
      const jsonPath =
        typeof ctx.config.jsonPath === 'string' && ctx.config.jsonPath.trim()
          ? ctx.config.jsonPath.trim()
          : undefined

      let url = assertSafeUrl(rawUrl)
      let response: Response | null = null
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetchImpl(url.toString(), {
          redirect: 'manual',
          headers: { Accept: 'application/json, text/*;q=0.8' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location || hop === MAX_REDIRECTS) throw new Error('Too many redirects.')
          // Every hop re-validated: a safe URL redirecting into the private
          // network is the classic SSRF second act.
          url = assertSafeUrl(new URL(location, url).toString())
          continue
        }
        break
      }
      if (!response || !response.ok) {
        throw new Error(`URL responded ${response?.status ?? 'with no status'}.`)
      }
      const text = await response.text()
      if (text.length > MAX_BYTES) throw new Error('Response exceeds the 1 MB limit.')

      const contentType = response.headers.get('content-type') ?? ''
      let value: number | null = null
      if (contentType.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
        try {
          value = extractJsonNumber(JSON.parse(text), jsonPath)
        } catch {
          value = extractTextNumber(text)
        }
      } else {
        value = extractTextNumber(text)
      }
      if (value === null) {
        throw new Error(
          jsonPath
            ? `No numeric value at '${jsonPath}'.`
            : 'No numeric value found in the response.',
        )
      }
      return { value, asOf: new Date() }
    },
  }
}

export const urlMetricSource = makeUrlMetricSource()
