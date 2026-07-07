/**
 * OAuth 2.0 authorization-code flow — STEP 1 (start).
 *
 * GET /api/mcp-connections/oauth/start?serverUrl=...&name=...
 *
 * 1. Discover the MCP server's OAuth metadata.
 * 2. Dynamically register a public client (DCR) for our callback redirect URI.
 * 3. Generate PKCE (S256) + a random CSRF `state`.
 * 4. Store everything we need for the callback in an ENCRYPTED, httpOnly,
 *    Secure, SameSite=Lax cookie (`bmcp_oauth`).
 * 5. Redirect the browser to the server's authorization endpoint (Okta SSO).
 *
 * Returns a real redirect Response so the browser follows the OAuth dance.
 */

import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecret } from '@/lib/crypto/secrets'
import {
  buildAuthorizeUrl,
  discoverAuthServer,
  generatePkce,
  generateState,
  registerClient,
} from '@/lib/mcp/oauth-authcode'

export const OAUTH_COOKIE = 'bmcp_oauth'
const COOKIE_MAX_AGE_S = 600 // 10 minutes to complete the login

export const GET = withAuthenticatedApi(async (request, auth) => {
  const serverUrl = request.nextUrl.searchParams.get('serverUrl')?.trim()
  const name = request.nextUrl.searchParams.get('name')?.trim()

  if (!serverUrl || !name) {
    return NextResponse.redirect(
      new URL('/connections?error=oauth_params', request.nextUrl.origin),
    )
  }

  // Validate the URL up front so a bad value can't blow up discovery.
  try {
    void new URL(serverUrl)
  } catch {
    return NextResponse.redirect(
      new URL('/connections?error=oauth_params', request.nextUrl.origin),
    )
  }

  const redirectUri = `${request.nextUrl.origin}/api/mcp-connections/oauth/callback`

  try {
    const meta = await discoverAuthServer(serverUrl)
    if (!meta.registration_endpoint) {
      throw new Error('OAuth server does not advertise a registration_endpoint')
    }

    const { client_id, client_secret } = await registerClient(
      meta.registration_endpoint,
      redirectUri,
    )

    const { verifier, challenge } = generatePkce()
    const state = generateState()

    const authorizeUrl = buildAuthorizeUrl(meta.authorization_endpoint, {
      clientId: client_id,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: 'claudeai',
    })

    // Everything the callback needs, sealed in an encrypted cookie.
    const cookieValue = encryptSecret(
      JSON.stringify({
        state,
        codeVerifier: verifier,
        clientId: client_id,
        clientSecret: client_secret,
        tokenEndpoint: meta.token_endpoint,
        serverUrl,
        name,
        organizationId: auth.organizationId,
      }),
    )

    const response = NextResponse.redirect(authorizeUrl)
    response.cookies.set(OAUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    })
    return response
  } catch {
    // Do not leak discovery/registration details to the client.
    return NextResponse.redirect(
      new URL('/connections?error=oauth_start', request.nextUrl.origin),
    )
  }
})
