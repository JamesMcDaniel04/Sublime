import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { safeReturnToPath } from '@/lib/auth/redirect'
import { ensureAppUser } from '@/lib/supabase/auth-utils'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

const OTP_TYPES = new Set(['signup', 'invite', 'magiclink', 'recovery', 'email_change'])

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  const type = request.nextUrl.searchParams.get('type')
  const next = safeReturnToPath(request.nextUrl.searchParams.get('next'))
  const supabase = await createClient()

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type && OTP_TYPES.has(type)
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any })
      : null

  if (!result || result.error || !result.data.user) {
    return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
  }

  try {
    // Provision before entering the application. This avoids the previous
    // state where the session was valid but every org-scoped API returned 403.
    await ensureAppUser(result.data.user)
  } catch (error) {
    apiLogger.error('Workspace provisioning failed during auth callback', {
      userId: result.data.user.id,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/auth/callback', operation: 'workspace_provisioning' })
    const errorUrl = new URL('/auth/auth-code-error', request.url)
    errorUrl.searchParams.set('reason', 'workspace_provisioning')
    return NextResponse.redirect(errorUrl)
  }

  return NextResponse.redirect(new URL(next, request.url))
}
