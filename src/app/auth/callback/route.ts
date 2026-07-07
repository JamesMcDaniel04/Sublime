import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

function safeNext(value: string | null) {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/dashboard'
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  const type = request.nextUrl.searchParams.get('type')
  const next = safeNext(request.nextUrl.searchParams.get('next'))
  const supabase = await createClient()

  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any })
      : { error: new Error('Missing auth code') }

  if (result.error) {
    return NextResponse.redirect(new URL('/auth/auth-code-error', request.url))
  }
  return NextResponse.redirect(new URL(next, request.url))
}
