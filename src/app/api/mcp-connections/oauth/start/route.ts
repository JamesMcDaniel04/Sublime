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
import { assertIntegrationCapacity } from '@/lib/billing/enforce'
import { encryptSecret } from '@/lib/crypto/secrets'
import { prisma } from '@/lib/prisma'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import {
  buildAuthorizeUrl,
  discoverAuthServer,
  generatePkce,
  generateState,
  registerClient,
  safeReturnToPath,
} from '@/lib/mcp/oauth-authcode'
import { sanitizeOAuthScope } from '@/lib/mcp/oauth-scope'
import { OAUTH_COOKIE } from '../cookie'

const COOKIE_MAX_AGE_S = 600 // 10 minutes to complete the login

export const GET = withAuthenticatedApi(async (request, auth) => {
  const serverUrl = request.nextUrl.searchParams.get('serverUrl')?.trim()
  const name = request.nextUrl.searchParams.get('name')?.trim()
  const connectionId = request.nextUrl.searchParams.get('connectionId')?.trim() || undefined
  const returnToRaw = request.nextUrl.searchParams.get('returnTo')?.trim() || undefined
  // Same-origin paths only — never an absolute URL.
  const returnTo = safeReturnToPath(returnToRaw)
  // Caller-controlled input in a security parameter: pin it to the RFC 6749
  // scope grammar rather than forwarding free text into the redirect.
  const rawScope = request.nextUrl.searchParams.get('scope')?.trim()
  const scope = rawScope ? sanitizeOAuthScope(rawScope) : 'claudeai'
  if (!scope) {
    return NextResponse.redirect(new URL('/connections?error=oauth_params', request.nextUrl.origin))
  }

  let effectiveServerUrl = serverUrl
  let effectiveName = name
  if (connectionId) {
    const row = await prisma.mcpConnection.findFirst({
      where: { id: connectionId, organizationId: auth.organizationId, userId: auth.dbUser.id },
      select: { id: true, serverUrl: true, name: true, userId: true },
    })
    if (!row) {
      return NextResponse.redirect(new URL('/connections?error=oauth_params', request.nextUrl.origin))
    }
    effectiveServerUrl = row.serverUrl
    effectiveName = row.name
  }

  if (!effectiveServerUrl || !effectiveName) {
    return NextResponse.redirect(
      new URL('/connections?error=oauth_params', request.nextUrl.origin),
    )
  }

  // A fresh connection (no connectionId = not a re-auth) lands as a new
  // mcpConnection row at the callback — gate it here, where a clean 403 is
  // still possible, instead of after the provider round-trip.
  if (!connectionId) await assertIntegrationCapacity(auth.organizationId)

  // SSRF guard: re-checked here (not just at connection-save time) so a host
  // that now resolves to a private/internal address is still blocked, and so
  // the new-connection path (which never went through the save-time guard)
  // can't be used to probe or POST to internal infrastructure.
  try {
    await assertPublicUrl(effectiveServerUrl)
  } catch (error) {
    if (error instanceof SsrfError) {
      return NextResponse.redirect(
        new URL('/connections?error=oauth_params', request.nextUrl.origin),
      )
    }
    throw error
  }

  const redirectUri = `${request.nextUrl.origin}/api/mcp-connections/oauth/callback`

  try {
    const meta = await discoverAuthServer(effectiveServerUrl)
    if (!meta.registration_endpoint) {
      throw new Error('OAuth server does not advertise a registration_endpoint')
    }
    // The discovery response is attacker-influenced for a malicious/compromised
    // MCP server — validate the endpoint it hands back before POSTing to it.
    await assertPublicUrl(meta.registration_endpoint)

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
      scope,
    })

    // Everything the callback needs, sealed in an encrypted cookie.
    const cookieValue = encryptSecret(
      JSON.stringify({
        state,
        codeVerifier: verifier,
        clientId: client_id,
        clientSecret: client_secret,
        tokenEndpoint: meta.token_endpoint,
        serverUrl: effectiveServerUrl,
        name: effectiveName,
        organizationId: auth.organizationId,
        connectionId,
        returnTo,
        userId: auth.dbUser.id,
        // Carried through so the callback can record WHICH access was granted
        // in its audit row — the token response does not return the scope.
        scope,
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
}, { requires: 'member' })
