/**
 * Resolve an MCP connection's stored-credential reference into an injection
 * plan.
 *
 * A connection may authenticate either with its own encrypted api_key blob
 * (the original form, still supported) or by pointing at a vault Credential —
 * `authConfig: { credentialId }`. The vault form is what lets one saved API key
 * serve several MCP servers and HTTP steps instead of being retyped per row.
 *
 * Kept out of mcpConfigFromConnection deliberately: that function is pure and
 * synchronous, and this one reads the database.
 */
import { resolveCredential } from '@/lib/credentials/resolve'
import type { InjectionPlan } from '@/lib/credentials/types'

export async function mcpCredentialPlan(
  conn: { serverUrl: string; authType: string; authConfig: unknown },
  ctx: { organizationId: string; userId?: string },
): Promise<InjectionPlan | undefined> {
  if (conn.authType !== 'api_key') return undefined
  const stored =
    conn.authConfig && typeof conn.authConfig === 'object' && !Array.isArray(conn.authConfig)
      ? (conn.authConfig as Record<string, unknown>)
      : {}
  const credentialId = typeof stored.credentialId === 'string' ? stored.credentialId.trim() : ''
  if (!credentialId) return undefined

  // resolveCredential enforces org scope and the credential's own domain
  // allow-list against this URL, then decrypts. It throws on either failure —
  // and it should: silently calling an MCP server unauthenticated would look
  // like a server-side permission bug to the user.
  return resolveCredential({
    credentialId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    requestUrl: conn.serverUrl,
  })
}
