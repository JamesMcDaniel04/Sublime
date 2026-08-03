import { NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { contentSecurityPolicy } from '@/lib/security/csp'

export async function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development')
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  const securedRequest = new NextRequest(request, { headers: requestHeaders })
  const response = await updateSession(securedRequest)
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|map|json|txt|woff|woff2|ttf|eot)$).*)',
  ],
}
