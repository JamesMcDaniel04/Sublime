/**
 * Security helpers for the PUBLIC webhook routes — flow/agent trigger, run
 * resume, Slack events. These authenticate by a per-resource secret and so do
 * NOT pass through withAuthenticatedApi, which means they also skipped the
 * auth.failed hook in api-handler. A wrong secret on the one unauthenticated,
 * brute-forceable surface emitted no signal at all.
 *
 * This module is the shared piece those routes call on a rejected request:
 *   - clientIp(request)              — the caller, for rate-limit keying + source
 *   - webhookAuthFailureEvent(...)   — the SecurityEvent to hand recordSecurityEvent
 *
 * The event carries ROUTE METADATA only (route name, resource id, reason). The
 * presented secret is never included — a security log written at exactly the
 * moment a bad secret arrives must not become the place that secret lands.
 */
import type { SecurityEvent } from '@/lib/security/alerts'
import { rateLimit } from '@/lib/ratelimit'

/** 1 MiB cap on a webhook body — the whole payload is stringified into a run or
 * a model prompt, so an unbounded read is a memory- and token-cost lever for
 * any secret holder. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024

export class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Read a request body as text, refusing anything over MAX_WEBHOOK_BODY_BYTES —
 * both the declared Content-Length and the actual streamed size, so a lying or
 * absent header cannot get past it. Throws PayloadTooLargeError at the moment
 * it crosses the limit.
 */
export async function readBodyWithLimit(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError()

  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError()
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/** Best-effort caller IP: first x-forwarded-for hop, then x-real-ip, then unknown. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  return 'unknown'
}

/**
 * Throttle a public webhook by resource id AND — when the caller IP is known —
 * by IP. Keying on the id alone is bypassable (fan a sweep across many ids from
 * one origin) and a DoS lever against one legitimate resource; the IP dimension
 * closes the fan-out. The IP check is SKIPPED when the IP is unattributable
 * ('unknown'), so a missing forwarded header cannot collapse every anonymous
 * caller into one shared bucket. Returns true when either limit is exceeded.
 */
export async function webhookThrottled(
  request: Request,
  opts: { key: string; resourceId: string; perResource?: number; perIp?: number; windowMs?: number },
): Promise<boolean> {
  const windowMs = opts.windowMs ?? 60_000
  const ip = clientIp(request)
  const checks = [rateLimit(`${opts.key}:${opts.resourceId}`, { limit: opts.perResource ?? 60, windowMs })]
  if (ip !== 'unknown') checks.push(rateLimit(`${opts.key}-ip:${ip}`, { limit: opts.perIp ?? 120, windowMs }))
  const results = await Promise.all(checks)
  return results.some((result) => !result.ok)
}

export type WebhookRoute =
  | 'flow.trigger'
  | 'flow.resume'
  | 'agent.trigger'
  | 'slack.events'

export interface WebhookAuthFailure {
  route: WebhookRoute
  /** The flow/agent/binding id the caller aimed at (never a secret). */
  resourceId: string
  reason: 'missing_secret' | 'invalid_secret' | 'bad_signature' | 'unknown_resource'
}

/**
 * The auth.failed event a webhook route emits on a 401. Sourced to the caller
 * IP so a brute-force from one origin crosses the threshold; detail is route
 * metadata only.
 */
export function webhookAuthFailureEvent(request: Request, failure: WebhookAuthFailure): SecurityEvent {
  return {
    kind: 'auth.failed',
    source: clientIp(request),
    detail: { route: failure.route, resourceId: failure.resourceId, reason: failure.reason },
  }
}
