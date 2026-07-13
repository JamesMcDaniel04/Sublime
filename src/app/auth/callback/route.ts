import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { safeReturnToPath } from '@/lib/auth/redirect'
import { ensureWorkspaceMembership } from '@/lib/supabase/auth-utils'

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
      : { error: new Error('Missing auth code') }

  if (result.error) {
    return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
  }
  const authenticatedUser = 'data' in result ? result.data?.user : null
  if (authenticatedUser) await ensureWorkspaceMembership(authenticatedUser)
  return NextResponse.redirect(new URL(next, request.url))
}
