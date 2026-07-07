/**
 * People.ai SalesAI webhook signature verification.
 *
 * SEAM: the exact header name/format comes from the SalesAI webhook docs at
 * registration time. This implements the common HMAC-SHA256 schemes:
 *   1. Timestamped: `t=<unix-ms>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`
 *      (replay-protected; what signPayload produces)
 *   2. Plain hex hmac of the raw body (fallback)
 * Both compare in constant time. Adjust here if People.ai's format differs —
 * callers only see a boolean.
 */

import crypto from 'node:crypto'

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

function hmacHex(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex')
  const bufferB = Buffer.from(b, 'hex')
  return bufferA.length > 0 && bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB)
}

/** Produce a timestamped signature header (used by tests and local tooling). */
export function signPayload(rawBody: string, secret: string, nowMs: number = Date.now()): string {
  return `t=${nowMs},v1=${hmacHex(secret, `${nowMs}.${rawBody}`)}`
}

export function verifySignature(input: {
  rawBody: string
  header: string | null | undefined
  secret: string
  toleranceMs?: number
  now?: () => number
}): boolean {
  const { rawBody, header, secret } = input
  if (!header || !secret) return false
  const now = input.now ?? Date.now
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS

  // Format 1: t=...,v1=...
  const timestampMatch = /(?:^|,)t=(\d+)/.exec(header)
  const signatureMatch = /(?:^|,)v1=([0-9a-f]+)/i.exec(header)
  if (timestampMatch && signatureMatch) {
    const timestamp = Number(timestampMatch[1])
    if (!Number.isFinite(timestamp)) return false
    if (Math.abs(now() - timestamp) > tolerance) return false
    return safeEqualHex(hmacHex(secret, `${timestamp}.${rawBody}`), signatureMatch[1])
  }

  // Format 2: plain hex hmac of the body.
  if (/^[0-9a-f]{64}$/i.test(header.trim())) {
    return safeEqualHex(hmacHex(secret, rawBody), header.trim())
  }

  return false
}
