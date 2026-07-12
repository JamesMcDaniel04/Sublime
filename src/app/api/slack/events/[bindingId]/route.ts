import { NextRequest, NextResponse, after } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import { cacheGet, cacheSet } from '@/lib/cache'
import { decryptSecretJson } from '@/lib/slack/connections'
import { verifySlackSignature } from '@/lib/slack/verify'
import { normalizeSlackEventPayload, normalizeSlackCommandPayload } from '@/lib/slack/payload'
import { routeSlackEvent } from '@/lib/slack/dispatch'

export const runtime = 'nodejs'
export const maxDuration = 300

const DEDUP_TTL_MS = 10 * 60_000

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
    // Public endpoint — throttle per binding to blunt floods (mirrors flow-trigger).
    const limited = await rateLimit(`slack-events:${bindingId ?? 'unknown'}`, { limit: 120, windowMs: 60_000 })
    if (!limited.ok) return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 })
    if (!bindingId) return NextResponse.json({ ok: false }, { status: 404 })

    // Raw body FIRST — the signature is computed over the exact bytes.
    const rawBody = await request.text()

    // systemPrisma: session-less ingress; the binding row (URL id) is the sole
    // tenant selector — payload team/org claims are never trusted.
    const binding = await systemPrisma.slackWorkspaceConnection.findFirst({ where: { id: bindingId, status: 'active' } })
    if (!binding) return NextResponse.json({ ok: false }, { status: 404 })

    // Slack signs EVERY request, including url_verification.
    const verified = verifySlackSignature({
      rawBody,
      timestamp: request.headers.get('x-slack-request-timestamp'),
      signature: request.headers.get('x-slack-signature'),
      signingSecret: decryptSecretJson(binding.signingSecret),
    })
    if (!verified) return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })

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

    // Dedup: Slack retries on slow acks — drop event_ids/trigger_ids seen in
    // the last 10 minutes.
    const dedupKey = `slack-event:${binding.id}:${normalized.dedupId}`
    if (await cacheGet<number>(dedupKey)) return NextResponse.json({ ok: true, duplicate: true })
    await cacheSet(dedupKey, 1, DEDUP_TTL_MS)

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
      routeSlackEvent(routeArgs).catch((error) =>
        apiLogger.error('slack event routing failed', { bindingId: binding.id, error: error instanceof Error ? error.message : String(error) }),
      ),
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
