/**
 * Cloudflare Turnstile verification for public, unauthenticated surfaces.
 *
 * The audit that prompted this found no bot-protection primitive anywhere in
 * the codebase. The exposed surfaces split in two, and they are defended
 * differently:
 *
 *  - Signup / login / password reset go browser → Supabase directly, so the
 *    app's rate limiter never sees them. Those pages render the widget and hand
 *    the token to Supabase via `options.captchaToken`; SUPABASE verifies it.
 *    This module is not involved.
 *  - `/api/contact` and `/api/feedback` are our own public routes. They call
 *    `assertHumanToken` before doing any work.
 *
 * Gated like every other optional integration in this codebase (see the RAG
 * block in .env.example and src/lib/ratelimit.ts): with TURNSTILE_SECRET_KEY
 * unset every check is a clean no-op, so a developer machine with no production
 * secrets behaves exactly as it did before.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TIMEOUT_MS = 5_000

export class TurnstileError extends Error {
  constructor(message = 'Bot check failed — please try again.') {
    super(message)
    this.name = 'TurnstileError'
  }
}

/** True when a secret key is configured and checks are therefore enforced. */
export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY)
}

/**
 * Throws `TurnstileError` unless Cloudflare confirms the token came from a
 * human. Resolves silently when unconfigured.
 *
 * Fails CLOSED — the deliberate opposite of src/lib/ratelimit.ts, which fails
 * open and documents why. A limiter outage costs throughput; a captcha that
 * fails open stops protecting the form at exactly the moment someone is
 * attacking the verification endpoint. Nothing on the critical login path
 * routes through here (Supabase verifies auth tokens itself), so a Cloudflare
 * outage degrades the contact form, never sign-in.
 *
 * `fetchImpl` is the same testing seam used by src/lib/import/fetch-url.ts.
 */
export async function assertHumanToken(
  token: string | undefined | null,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return

  if (!token) throw new TurnstileError('Complete the bot check before submitting.')

  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp) body.set('remoteip', remoteIp)

  let outcome: { success?: boolean } | null = null
  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new TurnstileError()
    outcome = (await response.json()) as { success?: boolean }
  } catch (error) {
    if (error instanceof TurnstileError) throw error
    throw new TurnstileError()
  }

  if (outcome?.success !== true) throw new TurnstileError()
}
