/**
 * Webhook trigger secrets, recoverable form (spec 2026-07-24 §5). The SHA-256
 * hash remains the ONLY validation path (trigger routes are untouched); the
 * AES-256-GCM ciphertext exists so an owner-only export can embed the
 * plaintext without rotating — rotation would silently break every previous
 * export and live integration.
 */
import { randomBytes } from 'crypto'
import { hashToken, encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

export function newTriggerSecret(): string {
  return randomBytes(24).toString('base64url')
}

export function withTriggerSecret(trigger: Record<string, unknown>, secret: string): Record<string, unknown> {
  return { ...trigger, type: 'webhook', webhookSecretHash: hashToken(secret), webhookSecretEnc: encryptSecret(secret) }
}

/** Decrypt the stored secret; null for legacy hash-only rows or bad ciphertext. */
export function readTriggerSecret(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null
  const enc = (trigger as Record<string, unknown>).webhookSecretEnc
  if (typeof enc !== 'string') return null
  try {
    return decryptSecret(enc)
  } catch {
    return null
  }
}
