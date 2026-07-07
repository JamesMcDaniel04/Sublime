/**
 * OAuth 2.0 authorization-code flow — STEP 2 (callback).
 *
 * GET /api/mcp-connections/oauth/callback?code=...&state=...
 *
 * 1. Read + decrypt the `bmcp_oauth` cookie set by the start route.
 * 2. Verify the returned `state` matches (CSRF protection).
 * 3. Exchange the authorization code (+ PKCE verifier) for tokens.
 * 4. Persist an McpConnection (authType 'oauth2', flow 'authcode') with all
 *    secrets ENCRYPTED in authConfig.
 * 5. Clear the cookie and redirect back to /connections.
 *
 * The `organizationId` is taken from the (trusted, encrypted) cookie that was
 * minted in the authenticated start route — the third-party redirect that
 * lands here cannot forge it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { exchangeCode } from '@/lib/mcp/oauth-authcode'
import { OAUTH_COOKIE } from '../start/route'

interface OAuthCookiePayload {
  state: string
  codeVerifier: string
  clientId: string
  clientSecret?: string
  tokenEndpoint: string
  serverUrl: string
  name: string
  organizationId: string
}

function redirect(request: NextRequest, query: string, clearCookie = false) {
  const response = NextResponse.redirect(
    new URL(`/connections?${query}`, request.nextUrl.origin),
  )
  if (clearCookie) {
    response.cookies.set(OAUTH_COOKIE, '', { path: '/', maxAge: 0 })
  }
  return response
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  const cookie = request.cookies.get(OAUTH_COOKIE)?.value

  // Parse + validate the encrypted state cookie.
  let payload: OAuthCookiePayload | null = null
  if (cookie) {
    try {
      payload = JSON.parse(decryptSecret(cookie)) as OAuthCookiePayload
    } catch {
      payload = null
    }
  }

  if (!code || !state || !payload || payload.state !== state) {
    return redirect(request, 'error=oauth_state', true)
  }

  const redirectUri = `${request.nextUrl.origin}/api/mcp-connections/oauth/callback`

  try {
    const tokens = await exchangeCode(payload.tokenEndpoint, {
      code,
      redirectUri,
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      codeVerifier: payload.codeVerifier,
    })

    const expiresInS =
      typeof tokens.expires_in === 'number' && tokens.expires_in > 0
        ? tokens.expires_in
        : 3600

    const authConfig = {
      flow: 'authcode' as const,
      clientId: payload.clientId,
      clientSecret: encryptSecret(payload.clientSecret || ''),
      tokenEndpoint: payload.tokenEndpoint,
      refreshToken: encryptSecret(tokens.refresh_token || ''),
      accessToken: encryptSecret(tokens.access_token),
      expiresAt: Date.now() + expiresInS * 1000,
    }

    await prisma.mcpConnection.create({
      data: {
        organizationId: payload.organizationId,
        name: payload.name,
        serverUrl: payload.serverUrl,
        authType: 'oauth2',
        authConfig: authConfig as Prisma.InputJsonValue,
        isActive: true,
      },
    })

    return redirect(request, 'connected=1', true)
  } catch (error) {
    // Never log tokens/secrets — only a scrubbed message.
    apiLogger.error('OAuth callback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return redirect(request, 'error=oauth', true)
  }
}
