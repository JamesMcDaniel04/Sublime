import { NextRequest, NextResponse, after } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecretJson } from '@/lib/slack/connections'
import { verifySlackSignature } from '@/lib/slack/verify'
import { normalizeSlackEventPayload, normalizeSlackCommandPayload } from '@/lib/slack/payload'
import { routeSlackEvent } from '@/lib/slack/dispatch'
import { claimSlackEvent, releaseSlackEvent } from '@/lib/slack/dedup'
import { recordSecurityEvent } from '@/lib/security/alerts'
import { PayloadTooLargeError, readBodyWithLimit, webhookAuthFailureEvent, webhookThrottled } from '@/lib/server/webhook-guard'

export const runtime = 'nodejs'
export const maxDuration = 300

// Generic, identical response for every ingress-auth failure — bad signature,
// unknown bindingId, inactive binding, and a corrupt signing secret are all
// indistinguishable from the outside. Distinguishing them (e.g. 404 for
// "doesn't exist" vs 401 for "exists but bad sig") is a bindingId existence
// oracle: it would let a caller enumerate valid binding ids by status code
// alone. Fail closed, identically, every time. The security signal, unlike the
// response, records the reason so a signature-forgery flood is not invisible.
function unauthorized(
  request: Request,
  bindingId: string,
  reason: 'unknown_resource' | 'bad_signature',
): NextResponse {
  recordSecurityEvent(webhookAuthFailureEvent(request, { route: 'slack.events', resourceId: bindingId, reason }))
  return NextResponse.json({ ok: false }, { status: 401 })
}

/**
 * `after()` requires a request-scoped work store, present only when Next.js
 * itself dispatches the request. Route-level unit tests (and any direct
 * invocation of POST outside the framework's request lifecycle) have no such
 * scope and `after()` throws synchronously. Fall back to a detached
 * fire-and-forget in that case — same effect (routing runs, ack already
 * sent), just without the serverless keep-alive guarantee `after()` gives in
 * production.
 */
function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task)
  } catch {
    apiLogger.warn('slack after() unavailable — running dispatch detached (no serverless keep-alive)')
    void task()
  }
}

// Slack ingress — one URL per binding (deterministic tenant lookup, what the
// manifest embeds). Public, session-less: mirrors the webhook trigger's
// systemPrisma posture, authenticated by Slack's request signature instead of
// a per-flow secret. Ack fast (<3s); routing + dispatch runs in after().
export async function POST(request: NextRequest) {
  try {
    const bindingId = request.nextUrl.pathname.split('/').at(-1)
    // Public endpoint — throttle per binding AND per caller IP (mirrors flow-trigger).
    if (await webhookThrottled(request, { key: 'slack-events', resourceId: bindingId ?? 'unknown', perResource: 120 })) {
      return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 })
    }
    if (!bindingId) return NextResponse.json({ ok: false }, { status: 404 })

    // Raw body FIRST — the signature is computed over the exact bytes. Bounded:
    // an unsigned oversized body must be refused before any work.
    let rawBody: string
    try {
      rawBody = await readBodyWithLimit(request)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return NextResponse.json({ ok: false, error: 'Request body too large' }, { status: 413 })
      rawBody = ''
    }

    // systemPrisma: session-less ingress; the binding row (URL id) is the sole
    // tenant selector — payload team/org claims are never trusted.
    const binding = await systemPrisma.slackWorkspaceConnection.findFirst({ where: { id: bindingId, status: 'active' } })
    // Unknown/inactive binding fails closed with the SAME response as a bad
    // signature (see `unauthorized` above) — never 404. A distinct status
    // here would let a caller enumerate valid binding ids for free.
    if (!binding) return unauthorized(request, bindingId, 'unknown_resource')

    // A corrupt/malformed signing-secret payload must fail closed, not throw
    // into the outer catch's generic 500 — same posture as every other
    // ingress-auth failure: log for operators, 401 for the caller, no dispatch.
    let signingSecret: string
    try {
      signingSecret = decryptSecretJson(binding.signingSecret)
    } catch (error) {
      apiLogger.error('slack ingress: corrupt signing secret', { bindingId: binding.id, error: error instanceof Error ? error.message : String(error) })
      return unauthorized(request, bindingId, 'bad_signature')
    }

    // Slack signs EVERY request, including url_verification.
    const verified = verifySlackSignature({
      rawBody,
      timestamp: request.headers.get('x-slack-request-timestamp'),
      signature: request.headers.get('x-slack-signature'),
      signingSecret,
    })
    if (!verified) return unauthorized(request, bindingId, 'bad_signature')

    const contentType = (request.headers.get('content-type') || '').toLowerCase()
    const isForm = contentType.includes('application/x-www-form-urlencoded')
    let parsed: unknown = null
    if (!isForm) {
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
      }
      const maybe = parsed as { type?: unknown; challenge?: unknown }
      if (maybe.type === 'url_verification' && typeof maybe.challenge === 'string') {
        return NextResponse.json({ challenge: maybe.challenge })
      }
    }

    const normalized = isForm
      ? normalizeSlackCommandPayload(Object.fromEntries(new URLSearchParams(rawBody)))
      : normalizeSlackEventPayload(parsed)
    // Unsupported event types still ack 200 — a non-2xx would make Slack retry.
    if (!normalized) return NextResponse.json({ ok: true, ignored: true })

    // Dedup: Slack retries on slow acks — drop event_ids/trigger_ids already
    // claimed. Atomic DB insert (see dedup.ts): the `create` either succeeds
    // (first time — dispatch) or hits the unique constraint (duplicate —
    // drop), decided by the database, not a check-then-set cache read. Global
    // across instances, no Redis needed.
    if (!(await claimSlackEvent(binding.id, normalized.dedupId))) {
      return NextResponse.json({ ok: true, duplicate: true })
    }

    // Echo guard: never react to our own (or any bot's) messages — reply loops.
    if (normalized.authorBotId || normalized.input.user === binding.botUserId) {
      return NextResponse.json({ ok: true, dropped: 'echo' })
    }

    const routeArgs = {
      bindingId: binding.id,
      organizationId: binding.organizationId,
      botUserId: binding.botUserId,
      normalized,
    }
    // Ack fast: routing + dispatch continues past the response via after().
    runAfterResponse(() =>
      routeSlackEvent(routeArgs).catch(async (error) => {
        apiLogger.error('slack event routing failed', { bindingId: binding.id, error: error instanceof Error ? error.message : String(error) })
        // Dispatch never ran to completion — release the claim so this
        // event_id/trigger_id isn't permanently deduped away. Slack's own
        // retry (or a manual replay) can then re-claim and re-run it.
        await releaseSlackEvent(binding.id, normalized.dedupId)
      }),
    )
    if (normalized.input.kind === 'slash_command') {
      return NextResponse.json({ response_type: 'ephemeral', text: 'Working on it…' })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    apiLogger.error('slack ingress failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
