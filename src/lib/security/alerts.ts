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
import { rateLimit } from '@/lib/ratelimit'
import { afterResponse } from '@/lib/server/after-response'
import { sendRawEmail } from '@/lib/email/send'
import { redactSecrets } from '@/lib/llm/guardrails'

export type SecurityEventKind =
  | 'rate_limit.exceeded'
  | 'captcha.failed'
  | 'auth.failed'
  | 'malware.detected'

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
}

/** At most one email per kind per hour, however long the attack runs. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000

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
export async function evaluateSecurityThreshold(event: SecurityEvent, send: AlertSender = sendRawEmail): Promise<void> {
  if (!securityAlertsConfigured()) return

  const threshold = THRESHOLDS[event.kind]
  if (!threshold) return

  // The counter IS a rate limiter: "not ok" means this kind has occurred more
  // than `count` times inside the window, which is precisely the condition.
  const counter = await rateLimit(`secevent:${event.kind}`, {
    limit: threshold.count,
    windowMs: threshold.windowSeconds * 1000,
  })
  if (counter.ok) return

  // Second limiter as the alert de-duplicator: once the threshold is crossed
  // the counter keeps reporting "not ok" for the rest of the window, so
  // without this every subsequent event would send another email — turning a
  // detection into an outage of its own.
  const mayAlert = await rateLimit(`secalert:${event.kind}`, { limit: 1, windowMs: ALERT_COOLDOWN_MS })
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
