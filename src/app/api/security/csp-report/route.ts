/**
 * Collector for Content-Security-Policy violation reports.
 *
 * Without a reporting sink a CSP can only ever be tightened by guesswork: you
 * change a directive, ship it, and find out from a support ticket. The audit
 * flagged this because the policy in src/lib/security/csp.ts is genuinely
 * load-bearing — it is what carries the exposure that httpOnly cannot, since
 * @supabase/ssr's shared session cookie must stay readable from JavaScript
 * (see SESSION_COOKIE_OPTIONS). A policy that important should not be blind.
 *
 * Unauthenticated by necessity: browsers post violation reports without
 * credentials, and the interesting reports are the ones from pages a signed-out
 * visitor loaded. It is therefore listed in route-permissions.test.ts's
 * DIFFERENTLY_AUTHENTICATED table with that reasoning.
 *
 * Deliberately inert: it reads no tenant data, writes nothing, and always
 * answers 204. The only resources it can consume are a log line and a rate
 * limit slot.
 */
import { NextRequest, NextResponse } from 'next/server'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A violating page can fire many reports quickly, and this endpoint is
// world-writable. Enough to characterise a real problem, not enough to be a
// free log-spam channel.
const REPORTS_PER_MINUTE = 60
// Reports are small; anything larger is not a report.
const MAX_REPORT_BYTES = 16 * 1024

/** The two shapes browsers actually send, normalised to what we log. */
function summarise(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null

  // Legacy `report-uri`: { "csp-report": { ... } }
  const legacy = (body as { 'csp-report'?: Record<string, unknown> })['csp-report']
  if (legacy) {
    return {
      directive: legacy['violated-directive'] ?? legacy['effective-directive'],
      blocked: legacy['blocked-uri'],
      document: legacy['document-uri'],
      disposition: legacy.disposition,
    }
  }

  // Reporting API `report-to`: [{ type: 'csp-violation', body: { ... } }]
  const entry = Array.isArray(body) ? body[0] : body
  const report = (entry as { body?: Record<string, unknown> })?.body
  if (report) {
    return {
      directive: report.effectiveDirective ?? report.violatedDirective,
      blocked: report.blockedURL,
      document: report.documentURL,
      disposition: report.disposition,
    }
  }

  return null
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`csp-report:${ip}`, { limit: REPORTS_PER_MINUTE, windowMs: 60_000 })
  // 204 even when limited: a browser cannot act on an error here, and a
  // non-2xx would only make it retry.
  if (!limited.ok) return new NextResponse(null, { status: 204 })

  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    return new NextResponse(null, { status: 204 })
  }

  const body = await request.json().catch(() => null)
  const summary = summarise(body)
  if (summary?.directive) {
    apiLogger.warn('CSP violation reported', summary)
  }

  return new NextResponse(null, { status: 204 })
}
