import { NextRequest, NextResponse } from 'next/server'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { envOAuthConfig } from '@/lib/peopleai/oauth'
import { completeConnect, OAUTH_COOKIE, TeamMismatchError } from '@/lib/peopleai/connect-service'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const runtime = 'nodejs'

function redirectWithStatus(request: NextRequest, returnTo: string, status: string) {
  const url = new URL(returnTo, request.nextUrl.origin)
  url.searchParams.set('peopleai', status)
  const response = NextResponse.redirect(url)
  response.cookies.delete(OAUTH_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const auth = await getAuthWithUser()
  if (!auth?.dbUser || !auth.organizationId) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  const cookie = request.cookies.get(OAUTH_COOKIE)?.value
  let payload: { state: string; verifier: string; returnTo: string } | null = null
  try {
    payload = cookie ? JSON.parse(cookie) : null
  } catch {
    payload = null
  }

  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  if (!payload || !code || !state || state !== payload.state) {
    return redirectWithStatus(request, '/dashboard', 'state-mismatch')
  }

  const config = envOAuthConfig(`${request.nextUrl.origin}/api/peopleai/callback`)
  if (!config) return redirectWithStatus(request, payload.returnTo, 'unconfigured')

  try {
    await completeConnect({
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
      code,
      verifier: payload.verifier,
      config,
    })
    return redirectWithStatus(request, payload.returnTo, 'connected')
  } catch (error) {
    if (error instanceof TeamMismatchError) {
      return redirectWithStatus(request, payload.returnTo, 'team-mismatch')
    }
    apiLogger.error('People.ai callback failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/api/peopleai/callback' })
    return redirectWithStatus(request, payload.returnTo, 'error')
  }
}
