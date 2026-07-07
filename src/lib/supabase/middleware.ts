import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseConfig } from './config'

const publicPages = new Set([
  '/',
  '/auth',
  '/auth/login',
  '/auth/signin',
  '/auth/signup',
  '/auth/callback',
  '/auth/auth-code-error',
  '/privacy',
  '/terms',
])

function copyCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie))
  return target
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const pathname = request.nextUrl.pathname
  const isApi = pathname.startsWith('/api/')

  // API routes authenticate themselves (withAuthenticatedApi → getUser), and a
  // route handler CAN persist a refreshed session cookie (cookies().set works
  // there) — so running getUser() here too was a fully redundant second
  // Supabase Auth network round-trip on EVERY API call. Skip it: middleware
  // auth is only for page navigations (login redirects + session refresh).
  if (isApi) return response

  const { url, anonKey } = getSupabaseConfig()
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookies) {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()
  const isAuthPage = pathname.startsWith('/auth/')

  // Production is SSO/invite-only: password signup is disabled unless
  // explicitly allowed (AUTH_ALLOW_PASSWORD=true keeps it for dev).
  if (pathname === '/auth/signup' && process.env.AUTH_ALLOW_PASSWORD === 'false') {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (!user && !isApi && !publicPages.has(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    url.searchParams.set('return_to', `${pathname}${request.nextUrl.search}`)
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (user && isAuthPage && pathname !== '/auth/callback') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return copyCookies(response, NextResponse.redirect(url))
  }

  return response
}
