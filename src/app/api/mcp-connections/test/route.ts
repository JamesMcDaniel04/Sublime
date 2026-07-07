import { z } from 'zod'
import { McpClient } from '@/lib/mcp/mcp-client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'

// Same schema as the main route (without id, without isActive)
const testSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  serverUrl: z.string().url(),
  authType: z.enum(['none', 'api_key', 'oauth2']).default('none'),
  // api_key fields
  apiKey: z.string().optional(),
  headerName: z.string().optional(),
  // oauth2 fields
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.string().optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  // Throttle: this endpoint makes server-side outbound requests to a
  // caller-supplied URL, so cap it to blunt scanning/abuse.
  const limited = await rateLimit(`mcp-test:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many connection tests — slow down.', 429, 'RATE_LIMITED')

  const data = testSchema.parse(await request.json().catch(() => ({})))

  // SSRF guard: reject internal/private/metadata targets before connecting.
  // Both serverUrl AND the oauth2 tokenUrl are fetched server-side, so guard both.
  try {
    await assertPublicUrl(data.serverUrl)
    if (data.tokenUrl) await assertPublicUrl(data.tokenUrl)
  } catch (error) {
    if (error instanceof SsrfError) return { ok: false, error: 'That server or token URL is not allowed.' }
    throw error
  }

  // Build runtime config directly from plaintext input — do NOT persist
  const client = new McpClient({
    serverUrl: data.serverUrl,
    authType: data.authType,
    apiKey: data.apiKey,
    headerName: data.headerName,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    tokenUrl: data.tokenUrl,
    scopes: data.scopes,
  })

  try {
    const tools = await client.getServerTools(data.serverUrl)
    const limited = tools.slice(0, 30)
    return {
      ok: true,
      toolCount: tools.length,
      toolNames: limited.map((t) => t.name),
    }
  } catch (error) {
    // Never leak secrets or internal stack traces
    const message =
      error instanceof Error ? error.message : 'Connection failed'

    // Scrub any potential credential leakage from the message
    const safeMessage = message
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[redacted]')
      .substring(0, 300)

    return { ok: false, error: safeMessage }
  }
})
