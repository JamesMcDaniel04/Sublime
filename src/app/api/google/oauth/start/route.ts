import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { assertIntegrationCapacity } from '@/lib/billing/enforce'
import {
  GOOGLE_SERVICE_SCOPES,
  buildAuthUrl,
  googleOAuthConfigured,
  signState,
  type GoogleOAuthService,
} from '@/lib/google/oauth'

export const runtime = 'nodejs'

/** Kicks off the native Google consent flow: 302 to Google with org/user
 *  context riding in the HMAC-signed state (the callback has no session). */
export const GET = withAuthenticatedApi(async (request, auth) => {
  if (!googleOAuthConfigured()) {
    throw new ApiError('Native Google OAuth is not configured.', 501, 'GOOGLE_OAUTH_UNCONFIGURED')
  }
  const service = request.nextUrl.searchParams.get('service') ?? 'google-mail'
  if (!(service in GOOGLE_SERVICE_SCOPES)) {
    throw new ApiError(`Unknown Google service: ${service}`, 400, 'GOOGLE_SERVICE_UNKNOWN')
  }
  // Reconnecting an existing service is always allowed; only a NEW service
  // connection lands as a new integration row at the callback — gate it here,
  // where a clean 403 is still possible, not after the consent round-trip.
  const existing = await prisma.googleOAuthConnection.findFirst({
    where: { organizationId: auth.organizationId, service },
    select: { id: true },
  })
  if (!existing) await assertIntegrationCapacity(auth.organizationId)

  const state = signState({
    organizationId: auth.organizationId,
    // dbUser.id, not auth.userId (the Supabase id): the callback persists
    // this as the connection rows' userId, which the status route and scan
    // plane query by DB user id.
    userId: auth.dbUser.id,
    service: service as GoogleOAuthService,
  })
  return NextResponse.redirect(buildAuthUrl({ service: service as GoogleOAuthService, state }))
}, { requires: 'member' })
