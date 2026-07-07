/**
 * Den MCP client
 *
 * Authenticates via either:
 *   a) Static bearer token: DEN_MCP_TOKEN
 *   b) OAuth 2.0 client-credentials:
 *        DEN_MCP_TOKEN_URL, DEN_MCP_CLIENT_ID,
 *        DEN_MCP_CLIENT_SECRET, DEN_MCP_SCOPES (optional)
 *
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

// ---------------------------------------------------------------------------
// Configuration check
// ---------------------------------------------------------------------------

export function denMcpConfigured(): boolean {
  const url = process.env.DEN_MCP_URL
  if (!url) return false

  const hasStaticToken = Boolean(process.env.DEN_MCP_TOKEN)
  const hasClientCreds =
    Boolean(process.env.DEN_MCP_TOKEN_URL) &&
    Boolean(process.env.DEN_MCP_CLIENT_ID) &&
    Boolean(process.env.DEN_MCP_CLIENT_SECRET)

  return hasStaticToken || hasClientCreds
}

/**
 * Per-request MCP timeout, read at call time (never at module load, per this
 * file's env contract). This is the legacy Den/People.ai MCP fallback, so
 * it honors the same PEOPLE_AI_MCP_TIMEOUT_MS knob; default 20s. Guarded so a
 * truthy-but-invalid value can't reach AbortSignal.timeout (which throws on
 * negatives/NaN).
 */
function requestTimeoutMs(): number {
  const parsed = Math.floor(Number(process.env.PEOPLE_AI_MCP_TIMEOUT_MS))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
}

// ---------------------------------------------------------------------------
// Token cache (module scope — one cache per process / worker)
// ---------------------------------------------------------------------------

interface CachedToken {
  value: string
  expiresAt: number // ms since epoch
}

// Max token lifetime we will honor, regardless of what the server reports, so a
// bogus/huge expires_in can't pin a stale token forever.
const MAX_TOKEN_TTL_S = 24 * 60 * 60 // 24h

let tokenCache: CachedToken | null = null
// Coalesce concurrent refreshes: while one fetch is in flight, other callers
// share the same Promise instead of each kicking off their own token request.
let inFlightToken: Promise<string> | null = null

async function fetchAccessToken(): Promise<string> {
  const tokenUrl = process.env.DEN_MCP_TOKEN_URL
  const clientId = process.env.DEN_MCP_CLIENT_ID
  const clientSecret = process.env.DEN_MCP_CLIENT_SECRET
  const scopes = process.env.DEN_MCP_SCOPES

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error(
      'Den MCP: no auth configured. Set DEN_MCP_TOKEN or ' +
        'DEN_MCP_TOKEN_URL + DEN_MCP_CLIENT_ID + DEN_MCP_CLIENT_SECRET.',
    )
  }

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  if (scopes) body.set('scope', scopes)

  // Send both body credentials and HTTP Basic auth — different OAuth servers
  // require different styles and including both is safe.
  const basicCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCredentials}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    // M5 — never echo the raw upstream response body; it may carry sensitive
    // detail. Log only the status code with a generic message.
    throw new Error(`Den MCP token request failed with status ${response.status}`)
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new Error('Den MCP token response did not include access_token')
  }

  // I6 — clamp expires_in to a sane maximum before computing the expiry.
  const rawExpiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600
  const expiresIn = Math.min(rawExpiresIn, MAX_TOKEN_TTL_S)
  tokenCache = { value: data.access_token, expiresAt: Date.now() + expiresIn * 1000 }

  return tokenCache.value
}

async function getAccessToken(): Promise<string> {
  const staticToken = process.env.DEN_MCP_TOKEN
  if (staticToken) return staticToken

  // Return cached token if still valid (with 60-second buffer)
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt - now > 60_000) {
    return tokenCache.value
  }

  // I6 — coalesce: if a refresh is already running, await it instead of
  // launching another. Clear the in-flight handle on both success and failure.
  if (inFlightToken) return inFlightToken

  inFlightToken = fetchAccessToken()
  try {
    return await inFlightToken
  } finally {
    inFlightToken = null
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

// Den MCP may use StreamableHTTP (SSE) or plain JSON — handle both.
function parseRpc(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) return { result: null }
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  let last: any = { result: null }
  for (const line of trimmed.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('data:')) continue
    const payload = l.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      last = JSON.parse(payload)
    } catch {
      /* keep scanning */
    }
  }
  return last
}

// ---------------------------------------------------------------------------
// DenMcpClient
// ---------------------------------------------------------------------------

export class DenMcpClient {
  private readonly readyServers = new Set<string>()
  private readonly sessionIds = new Map<string, string>()
  private rpcId = 1

  private async rpc(serverUrl: string, method: string, params?: Record<string, unknown>, notification = false) {
    const token = await getAccessToken()

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }

    const sessionId = this.sessionIds.get(serverUrl)
    if (sessionId) headers['Mcp-Session-Id'] = sessionId

    const response = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(!notification ? { id: this.rpcId++ } : {}),
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(requestTimeoutMs()),
    })

    if (!response.ok) {
      throw new Error(`Den MCP server returned ${response.status} for method ${method}`)
    }

    // Capture session id from initialize response (if provided)
    if (method === 'initialize') {
      const sid = response.headers.get('Mcp-Session-Id')
      if (sid) this.sessionIds.set(serverUrl, sid)
    }

    if (notification) return { result: null }
    return parseRpc(await response.text())
  }

  private async initialize(serverUrl: string) {
    if (this.readyServers.has(serverUrl)) return
    const response = await this.rpc(serverUrl, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'DenStudio', version: '1.0.0' },
    })
    if (response.error) throw new Error(response.error.message || 'Unable to initialize Den MCP server')
    await this.rpc(serverUrl, 'notifications/initialized', undefined, true)
    this.readyServers.add(serverUrl)
  }

  async getServerTools(serverUrl: string): Promise<{ name: string; description?: string; inputSchema?: any }[]> {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/list')
    if (response.error) throw new Error(response.error.message || 'Unable to list Den MCP tools')
    const tools = response.result?.tools || response.result?.items || []
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || tool.input_schema || tool.parameters || { type: 'object', properties: {} },
    }))
  }

  async executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any> {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message || `Tool ${name} failed`)
    return response.result
  }
}
