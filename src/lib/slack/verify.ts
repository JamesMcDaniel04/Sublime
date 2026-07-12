/**
 * Slack request-signature verification (pure — unit-tested with known vectors).
 * v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}") over the EXACT raw
 * request bytes, timing-safe compare, ±300s timestamp window.
 */
import crypto from 'crypto'

export const SLACK_SIGNATURE_WINDOW_SECONDS = 300

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')
}

export function verifySlackSignature(args: {
  rawBody: string
  timestamp: string | null
  signature: string | null
  signingSecret: string
  nowMs?: number
}): boolean {
  const { rawBody, timestamp, signature, signingSecret } = args
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - ts) > SLACK_SIGNATURE_WINDOW_SECONDS) return false
  const expected = Buffer.from(computeSlackSignature(signingSecret, timestamp, rawBody), 'utf8')
  const provided = Buffer.from(signature, 'utf8')
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided)
}
