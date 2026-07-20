import { NextResponse } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
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
  const state = signState({
    organizationId: auth.organizationId,
    // dbUser.id, not auth.userId (the Supabase id): the callback persists
    // this as the connection rows' userId, which the status route and scan
    // plane query by DB user id.
    userId: auth.dbUser.id,
    service: service as GoogleOAuthService,
  })
  return NextResponse.redirect(buildAuthUrl({ service: service as GoogleOAuthService, state }))
})
