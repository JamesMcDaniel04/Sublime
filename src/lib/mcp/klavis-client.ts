import { klavisServerName } from './provider-capabilities'

export type KlavisServer = {
  instanceId: string
  serverUrl?: string
  oauthUrl?: string
  isAuthenticated: boolean
  authNeeded: boolean
}

type KlavisClientOptions = {
  apiKey: string
  baseUrl?: string
  platformName?: string
}

// Typed error so callers can distinguish account-limit / validation / transient
// failures and surface a useful message instead of a raw 500.
export class KlavisError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'limit_reached' | 'invalid_request' | 'unauthorized' | 'transient' | 'unknown',
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'KlavisError'
  }
}

function classify(status: number, detail: string): KlavisError {
  if (/creation limit reached|limit:\s*\d+/i.test(detail)) {
    // Klavis caps distinct end-users per account (free tier: 3), not tools —
    // each workspace member who connects a Klavis tool counts as one user.
    return new KlavisError('Klavis plan limit reached — your Klavis account is at its user limit. Upgrade your Klavis plan to connect tools for more people.', status, 'limit_reached', detail)
  }
  if (status === 401 || status === 403) return new KlavisError('Klavis API key is invalid or unauthorized.', status, 'unauthorized', detail)
  if (status === 422 || status === 400) return new KlavisError(`Klavis rejected the request: ${detail.slice(0, 160)}`, status, 'invalid_request', detail)
  if (status >= 500) return new KlavisError('Klavis service is temporarily unavailable.', status, 'transient', detail)
  return new KlavisError(`Klavis API error (${status}).`, status, 'unknown', detail)
}

export class KlavisClient {
  private readonly baseUrl: string
  private readonly platformName: string
  private readonly readyServers = new Set<string>()
  private rpcId = 1

  constructor(private readonly options: KlavisClientOptions) {
    if (!options.apiKey) throw new Error('KlavisClient requires an API key')
    this.baseUrl = options.baseUrl || 'https://api.klavis.ai'
    this.platformName = options.platformName || 'den'
  }

  async createServerInstance(provider: string, userId: string): Promise<KlavisServer> {
    const serverName = klavisServerName(provider)
    if (!serverName) throw new KlavisError(`"${provider}" is not a supported Klavis server.`, 400, 'invalid_request')
    const data = await this.api('/mcp-server/instance/create', {
      method: 'POST',
      body: JSON.stringify({ serverName, userId, platformName: this.platformName }),
    })
    return this.toServer(data)
  }

  async getServerStatus(instanceId: string): Promise<KlavisServer> {
    return this.toServer(await this.api(`/mcp-server/instance/${instanceId}`))
  }

  async deleteServerInstance(instanceId: string) {
    await this.api(`/mcp-server/instance/${instanceId}`, { method: 'DELETE' })
  }

  async getServerTools(serverUrl: string) {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/list')
    if (response.error) throw new Error(response.error.message || 'Unable to list MCP tools')
    const tools = response.result?.tools || response.result?.items || []
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || tool.input_schema || tool.parameters || { type: 'object', properties: {} },
    }))
  }

  async executeTool(serverUrl: string, name: string, args: Record<string, unknown>) {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message || `Tool ${name} failed`)
    return response.result
  }

  private async initialize(serverUrl: string) {
    if (this.readyServers.has(serverUrl)) return
    const response = await this.rpc(serverUrl, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'Den', version: '1.0.0' },
    })
    if (response.error) throw new Error(response.error.message || 'Unable to initialize MCP server')
    await this.rpc(serverUrl, 'notifications/initialized', undefined, true)
    this.readyServers.add(serverUrl)
  }

  private async api(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      // Network failure or timeout — retry once before giving up.
      if (attempt < 1) return this.api(path, init, attempt + 1)
      throw new KlavisError('Could not reach Klavis (network or timeout).', 503, 'transient', String(error))
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // Retry transient 5xx once; surface 4xx immediately (real errors).
      if (response.status >= 500 && attempt < 1) return this.api(path, init, attempt + 1)
      throw classify(response.status, detail)
    }
    return response.status === 204 ? {} : response.json()
  }

  private async rpc(serverUrl: string, method: string, params?: Record<string, unknown>, notification = false) {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(!notification ? { id: this.rpcId++ } : {}),
        method,
        ...(params ? { params } : {}),
      }),
      // Bound the request so an unresponsive Klavis MCP server can't hang an
      // agent run indefinitely (mirrors api()'s 15s). Aborts throw, which the
      // callers (loadTools / executeTool) already handle.
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`)
    if (notification) return { result: null }
    return parseRpc(await response.text())
  }

  private toServer(data: any): KlavisServer {
    return {
      instanceId: data.instanceId,
      serverUrl: data.serverUrl ?? undefined,
      oauthUrl: data.oauthUrl ?? undefined,
      isAuthenticated: Boolean(data.isAuthenticated),
      authNeeded: data.authNeeded ?? Boolean(data.oauthUrl),
    }
  }
}

// Klavis StreamableHttp returns JSON-RPC either as plain JSON or as an SSE
// stream (`data: {...}` lines). Handle both; return the last JSON-RPC message.
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
    try { last = JSON.parse(payload) } catch { /* keep scanning */ }
  }
  return last
}
