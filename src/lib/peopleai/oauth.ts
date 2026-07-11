/**
 * People.ai MCP OAuth client (authorization-code + PKCE).
 *
 * Sublime is a registered OAuth client of mcp.people.ai — the same
 * surface Claude and Copilot integrate against. The user's browser is sent to
 * the MCP authorize endpoint; People.ai internally delegates sign-in to Glass
 * → Salesforce and redirects back to our callback with an authorization code,
 * which we exchange for `mcp_*` access/refresh tokens scoped to that user's
 * People.ai permissions.
 *
 * Config comes from PEOPLE_AI_OAUTH_CLIENT_ID / PEOPLE_AI_OAUTH_CLIENT_SECRET
 * (+ optional PEOPLE_AI_OAUTH_SCOPE, PEOPLE_AI_MCP_BASE_URL).
 */

import crypto from 'node:crypto'

export const PEOPLE_AI_MCP_BASE_URL = 'https://mcp.people.ai'

export interface PeopleAiOAuthConfig {
  clientId: string
  clientSecret?: string
  redirectUri: string
  scope?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface AuthorizationServerMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  tokenType: string
  raw: Record<string, unknown>
}

export function envOAuthConfig(redirectUri: string): PeopleAiOAuthConfig | null {
  const clientId = process.env.PEOPLE_AI_OAUTH_CLIENT_ID
  if (!clientId) return null
  return {
    clientId,
    clientSecret: process.env.PEOPLE_AI_OAUTH_CLIENT_SECRET,
    scope: process.env.PEOPLE_AI_OAUTH_SCOPE || undefined,
    baseUrl: process.env.PEOPLE_AI_MCP_BASE_URL || undefined,
    redirectUri,
  }
}

// ── PKCE ────────────────────────────────────────────────────────────────────

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url') // 64 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function discoverMetadata(config: PeopleAiOAuthConfig): Promise<AuthorizationServerMetadata> {
  const base = (config.baseUrl || PEOPLE_AI_MCP_BASE_URL).replace(/\/$/, '')
  const fetchImpl = config.fetchImpl ?? fetch
  const fallback: AuthorizationServerMetadata = {
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
  }

  try {
    const response = await fetchImpl(`${base}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return fallback
    const doc = (await response.json()) as Record<string, unknown>
    return {
      authorizationEndpoint: typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : fallback.authorizationEndpoint,
      tokenEndpoint: typeof doc.token_endpoint === 'string' ? doc.token_endpoint : fallback.tokenEndpoint,
    }
  } catch {
    // The documented endpoints are stable; discovery is best-effort.
    return fallback
  }
}

// ── Authorize URL ───────────────────────────────────────────────────────────

export function buildAuthorizeUrl(
  config: PeopleAiOAuthConfig,
  params: { authorizationEndpoint: string; state: string; codeChallenge: string },
): string {
  const url = new URL(params.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (config.scope) url.searchParams.set('scope', config.scope)
  return url.toString()
}

// ── Token endpoint calls ────────────────────────────────────────────────────

async function tokenRequest(
  config: PeopleAiOAuthConfig,
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<TokenSet> {
  const fetchImpl = config.fetchImpl ?? fetch
  body.set('client_id', config.clientId)
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    // Never echo the upstream body — it can carry sensitive detail.
    throw new Error(`People.ai token endpoint returned ${response.status}`)
  }

  const raw = (await response.json()) as Record<string, unknown>
  const accessToken = raw.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('People.ai token endpoint returned no access_token')
  }
  return {
    accessToken,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : 'Bearer',
    raw,
  }
}

export async function exchangeCode(
  config: PeopleAiOAuthConfig,
  params: { tokenEndpoint: string; code: string; codeVerifier: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    code_verifier: params.codeVerifier,
  })
  return tokenRequest(config, params.tokenEndpoint, body)
}

export async function refreshTokens(
  config: PeopleAiOAuthConfig,
  params: { tokenEndpoint: string; refreshToken: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  })
  const tokens = await tokenRequest(config, params.tokenEndpoint, body)
  // Servers may rotate or omit the refresh token; keep the old one when omitted.
  return { ...tokens, refreshToken: tokens.refreshToken ?? params.refreshToken }
}
