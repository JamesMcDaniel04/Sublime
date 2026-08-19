/**
 * Security event recording, and an alert when the volume looks like an attack.
 *
 * The audit that prompted this found comprehensive LOGGING and zero ALERTING.
 * Sentry cannot cover the gap, and it is worth being precise about why: Sentry
 * reports errors, and a successful attack does not throw. A 429 is a normal
 * response. A credential read is a feature. The signal lives entirely in the
 * RATE of ordinary responses, which is the one thing error tracking is blind to.
 *
 * Two independent outputs, deliberately:
 *
 *   1. A structured log line, ALWAYS, for every event. This is the forensic
 *      trail — the thing you read after the fact — and it does not depend on
 *      any other system being up.
 *   2. An email, only when a threshold is crossed. This is the "someone is
 *      attacking right now" signal.
 *
 * Gated like every other optional integration here: with SECURITY_ALERT_EMAIL
 * unset, (1) still happens and (2) is a clean no-op.
 *
 * KNOWN LIMITATION, stated rather than buried: counting reuses the shared rate
 * limiter, which FAILS OPEN by design (src/lib/ratelimit.ts). During a Redis
 * outage the counter reports "under threshold" and no email is sent. That is
 * the wrong direction for detection, and it is the price of not standing up a
 * second counting store. The log line in (1) is unaffected, so the trail
 * survives even when the alert does not.
 */

import { apiLogger } from '@/lib/logger'
import { rateLimit, type RateLimitResult } from '@/lib/ratelimit'
import { afterResponse } from '@/lib/server/after-response'
import { sendRawEmail } from '@/lib/email/send'
import { redactSecrets } from '@/lib/llm/guardrails'

export type SecurityEventKind =
  | 'rate_limit.exceeded'
  | 'captcha.failed'
  | 'auth.failed'
  | 'malware.detected'
  | 'egress.blocked'

/**
 * How many events in what window before this is worth waking someone for.
 *
 * Tuned so ordinary bad days stay quiet: a user fat-fingering a password, one
 * scripted client hitting a limit. Malware is the exception — a single
 * confirmed hit is always worth knowing about, because it means someone
 * deliberately uploaded something.
 */
const THRESHOLDS: Record<SecurityEventKind, { count: number; windowSeconds: number }> = {
  'rate_limit.exceeded': { count: 100, windowSeconds: 600 },
  'captcha.failed': { count: 25, windowSeconds: 600 },
  'auth.failed': { count: 50, windowSeconds: 600 },
  'malware.detected': { count: 1, windowSeconds: 3600 },
  // A workflow or agent repeatedly trying to reach a blocked host is either a
  // misconfiguration or an exfiltration attempt probing for a way out. A
  // handful is noise; a burst is worth a look.
  'egress.blocked': { count: 20, windowSeconds: 600 },
}

/** At most one email per kind per hour, however long the attack runs. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

/**
 * Process-local cooldown for the "detection is degraded" alert. It cannot use
 * the shared limiter for dedup — the shared limiter being down is the very
 * thing it reports, so its dedup would be degraded too. In-memory means one
 * alert per process per hour; during a real outage every warm instance sends
 * at most one, which is the acceptable ceiling.
 */
let lastDegradedAlertAt = 0

/** Test seam: reset the process-local degraded-alert cooldown. */
export function resetSecurityAlertState(): void {
  lastDegradedAlertAt = 0
}

export type RateLimiterFn = (key: string, options: { limit: number; windowMs: number }) => Promise<RateLimitResult>

interface EvaluateDeps {
  send?: AlertSender
  limiter?: RateLimiterFn
  now?: () => number
}

export interface SecurityEvent {
  kind: SecurityEventKind
  /** Who to blame: client IP, user id, or org id. Free-form; only logged. */
  source?: string
  organizationId?: string
  detail?: Record<string, unknown>
}

export function securityAlertsConfigured(): boolean {
  return Boolean(process.env.SECURITY_ALERT_EMAIL)
}

/**
 * Record a security-relevant event. Never throws, never blocks the response.
 *
 * Deliberately synchronous-looking with fire-and-forget internals: every call
 * site is on a request path that has already decided to reject, and none of
 * them should grow a latency or failure dependency on alerting.
 */
export function recordSecurityEvent(event: SecurityEvent): void {
  // (1) The trail. Redacted because `detail` comes from request context and a
  // rejected request is exactly where a stray credential tends to appear.
  apiLogger.warn(`security: ${event.kind}`, {
    kind: event.kind,
    source: event.source,
    organizationId: event.organizationId,
    ...(event.detail ? { detail: JSON.parse(redactSecrets(JSON.stringify(event.detail))) } : {}),
  })

  // (2) The signal.
  afterResponse(() => evaluateSecurityThreshold(event))
}

/** Injectable sender, mirroring the `fetchImpl` seam used across this codebase. */
export type AlertSender = (input: { to: string; subject: string; text: string }) => Promise<void>

/**
 * The awaitable core of the alert path.
 *
 * Exported because recordSecurityEvent fires it through afterResponse and is
 * therefore unawaitable by construction — a test driving the public function
 * would be racing the thing it is asserting on.
 */
export async function evaluateSecurityThreshold(event: SecurityEvent, deps: EvaluateDeps = {}): Promise<void> {
  if (!securityAlertsConfigured()) return

  const send = deps.send ?? sendRawEmail
  const limiter = deps.limiter ?? rateLimit
  const now = deps.now ?? Date.now

  const threshold = THRESHOLDS[event.kind]
  if (!threshold) return

  // The counter IS a rate limiter: "not ok" means this kind has occurred more
  // than `count` times inside the window, which is precisely the condition.
  const counter = await limiter(`secevent:${event.kind}`, {
    limit: threshold.count,
    windowMs: threshold.windowSeconds * 1000,
  })

  // Fail closed: a degraded counter means the detector is blind right now.
  // Alert on THAT (deduped process-locally) rather than the previous silent
  // under-count.
  if (counter.degraded) {
    if (now() - lastDegradedAlertAt >= ALERT_COOLDOWN_MS) {
      lastDegradedAlertAt = now()
      await sendDegradedAlert(event, send)
    }
    return
  }

  if (counter.ok) return

  // Second limiter as the alert de-duplicator: once the threshold is crossed
  // the counter keeps reporting "not ok" for the rest of the window, so
  // without this every subsequent event would send another email — turning a
  // detection into an outage of its own.
  const mayAlert = await limiter(`secalert:${event.kind}`, { limit: 1, windowMs: ALERT_COOLDOWN_MS })
  if (!mayAlert.ok) return

  await sendAlert(event, threshold, send)
}

async function sendAlert(
  event: SecurityEvent,
  threshold: { count: number; windowSeconds: number },
  send: AlertSender,
): Promise<void> {
  const to = process.env.SECURITY_ALERT_EMAIL
  if (!to) return

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'the application'
  const lines = [
    `Threshold crossed: ${event.kind}`,
    '',
    `More than ${threshold.count} occurrences in ${Math.round(threshold.windowSeconds / 60)} minutes.`,
    `Environment: ${process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'}`,
    `Application: ${appUrl}`,
    '',
    `Most recent source: ${event.source ?? 'unknown'}`,
    event.organizationId ? `Workspace: ${event.organizationId}` : null,
    event.detail ? `Detail: ${redactSecrets(JSON.stringify(event.detail))}` : null,
    '',
    'Further alerts of this kind are suppressed for one hour. Every individual',
    'event is in the application logs under "security:" whether or not an alert',
    'was sent — search there for the full picture.',
  ].filter((line) => line !== null)

  try {
    await send({
      to,
      subject: `[Sublime security] ${event.kind} threshold crossed`,
      text: lines.join('\n'),
    })
  } catch (error) {
    // Resend unconfigured or failing. The log line already recorded the event;
    // losing the email must not turn a detection into an exception.
    apiLogger.error('security alert email failed', {
      kind: event.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The fail-closed signal: the counting backend is unreachable, so thresholds
 * cannot be evaluated and attacks in progress would go unnoticed. This is a
 * distinct alert from a threshold crossing — the action is "check Redis/Upstash",
 * not "check the attacker".
 */
async function sendDegradedAlert(event: SecurityEvent, send: AlertSender): Promise<void> {
  const to = process.env.SECURITY_ALERT_EMAIL
  if (!to) return

  apiLogger.error('security: detection degraded', {
    reason: 'rate-limit backend unreachable — thresholds cannot be evaluated',
    lastEventKind: event.kind,
  })

  const text = [
    'Security detection is DEGRADED.',
    '',
    'The shared rate-limit backend (Redis/Upstash) is unreachable, so security',
    'thresholds cannot be counted and an attack in progress may not raise an',
    'alert. Endpoints continue to serve (limits fail open by design); only the',
    'detector is blind.',
    '',
    `Environment: ${process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown'}`,
    'Action: check the rate-limit backend. Individual events are still in the',
    'application logs under "security:".',
    '',
    'Further degraded-detection alerts are suppressed for one hour per instance.',
  ].join('\n')

  try {
    await send({ to, subject: '[Sublime security] detection degraded — counting backend unreachable', text })
  } catch (error) {
    apiLogger.error('security degraded alert email failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
