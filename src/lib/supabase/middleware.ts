import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseConfig } from './config'
import { safeReturnTo } from './return-to'
import { PUBLIC_PATHS as publicPages } from '@/lib/auth/public-paths'

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
    // Carry the destination across the bounce. An invited teammate arrives at
    // /auth/signup with the invite in the query string; clearing it here drops
    // the invite on the floor, so they sign in, land on /dashboard, and never
    // join the thing they were invited to. Preserve an existing return_to
    // rather than nesting one.
    const destination = request.nextUrl.searchParams.get('return_to')
    url.search = ''
    if (destination) url.searchParams.set('return_to', destination)
    else if (request.nextUrl.search) {
      url.searchParams.set('return_to', `${pathname}${request.nextUrl.search}`)
    }
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (!user && !isApi && !publicPages.has(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    url.searchParams.set('return_to', `${pathname}${request.nextUrl.search}`)
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (user && isAuthPage && pathname !== '/auth/callback' && pathname !== '/auth/update-password') {
    const url = request.nextUrl.clone()
    // An already-signed-in user following an invite link still carries the
    // destination. Sending them to /dashboard and discarding it is the same
    // lost-invite bug from the other direction — they are authenticated, they
    // clicked the right link, and they land nowhere near it. safeReturnTo
    // refuses anything that is not a same-origin path, so this cannot become
    // an open redirect.
    const target = safeReturnTo(request.nextUrl.searchParams.get('return_to'), '/dashboard')
    url.pathname = target.pathname
    url.search = ''
    for (const [key, value] of target.params) url.searchParams.set(key, value)
    return copyCookies(response, NextResponse.redirect(url))
  }

  // Authenticated pages must not be cached by the browser (disk / back-forward
  // cache), so a signed-out "Back" can't restore a protected view. The client
  // pageshow guard covers browsers that bfcache no-store pages anyway.
  if (!publicPages.has(pathname)) {
    response.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate')
  }

  return response
}
