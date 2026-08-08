/**
 * HTTP API integration — a built-in agent tool for calling external REST/JSON
 * APIs mid-run (query endpoints, enrich records, hit internal services).
 *
 * Safety: assertPublicUrl blocks private/internal targets (SSRF), redirects are
 * refused (they could bypass the check), one attempt is capped at 30s, and the
 * response body is truncated so a huge payload can't blow the context window.
 * Non-GET calls are unconditionally approval-gated (see toolNeedsApproval) —
 * the model chooses URL, headers, AND body, so an un-gated POST is a data
 * exfiltration primitive for any injected instruction in retrieved content.
 * HTTP_TOOL_ALLOWED_DOMAINS (comma-separated hostnames; subdomains match)
 * optionally restricts egress to an allowlist; unset means any public host.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { fetchPublicUrl } from '@/lib/net/ssrf'

const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 50_000

/** True when `host` is `domain` or a subdomain of it. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** Throws unless the URL's host passes the egress allowlist (no-op when unset). */
export function assertEgressAllowed(url: string, allowlistEnv = process.env.HTTP_TOOL_ALLOWED_DOMAINS): void {
  const domains = (allowlistEnv ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  if (domains.length === 0) return
  const host = new URL(url).hostname.toLowerCase()
  if (!domains.some((domain) => hostMatches(host, domain))) {
    throw new Error(`HTTP tool egress to "${host}" is not permitted by this workspace's allowed-domains policy.`)
  }
}

export function httpTools(): ToolDefinition[] {
  return [
    {
      name: 'request',
      description:
        'Make an HTTP request to an external API and return the response. Use for querying REST/JSON APIs (GET) or sending data to them (POST/PUT/PATCH/DELETE). Public hosts only. Pass auth via the headers object when the user has supplied credentials in your instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET).' },
          url: { type: 'string', description: 'Absolute https URL to call.' },
          headers: { type: 'object', description: 'Optional request headers, e.g. {"authorization": "Bearer …"}.' },
          body: { type: 'string', description: 'Optional request body (typically JSON). Ignored for GET.' },
        },
        required: ['url'],
      },
    },
  ]
}

export class HttpToolClient {
  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'request') throw new Error(`Unknown HTTP tool: ${name}`)
    const url = String(args.url || '')
    assertEgressAllowed(url)

    const method = String(args.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
      for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }
    }
    const body = typeof args.body === 'string' && method !== 'GET' ? args.body : undefined
    if (body && !headers['content-type']) headers['content-type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const response = await fetchPublicUrl(url, { method, headers, body, signal: controller.signal, redirect: 'error' })
      const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS)
      return { status: response.status, ok: response.ok, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}
