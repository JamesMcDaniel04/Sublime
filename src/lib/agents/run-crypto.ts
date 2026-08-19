/**
 * Encryption at rest for agent RUN DATA — transcripts, inputs, outputs, plans,
 * and per-message content.
 *
 * These are the fattest plaintext in a database dump: full model conversations,
 * tool arguments, and customer data, none of it in the credential vault and so
 * none of it previously encrypted. This mirrors the knowledge-chunk pattern
 * (src/lib/knowledge/store.ts) but stores the ciphertext IN PLACE — the Json
 * columns hold a ciphertext STRING instead of the object, and the content Text
 * column holds a ciphertext string instead of the message — so no schema column
 * rename is needed and every existing select/omit keeps working.
 *
 * Two properties make this safe to roll out incrementally:
 *   1. WHEN NO KEY IS CONFIGURED it is an identity passthrough — the value is
 *      stored and read exactly as before. Local/dev and the keyless test suite
 *      are unaffected; production (ENCRYPTION_KEY set) encrypts.
 *   2. READS decrypt only what LOOKS encrypted and pass everything else through,
 *      so a legacy plaintext row written before this landed still reads
 *      correctly, and a row written under a rotated key is covered by
 *      decryptSecret's OLD_ENCRYPTION_KEY fallback.
 */
import { decryptSecret, encryptionConfigured, encryptSecret } from '@/lib/crypto/secrets'
import type { Prisma } from '@/generated/prisma/client'

const CIPHERTEXT = /^(?:v2:|v1:|b64:)/

/** Encrypt a JSON-serialisable run value for at-rest storage in a Json column. */
export function encryptRunValue(value: unknown): Prisma.InputJsonValue {
  // null/undefined pass through for callers that wrap in jsonValue() (which
  // coerces them to a SQL NULL); the double cast keeps the ergonomic signature.
  if (value === null || value === undefined) return value as unknown as Prisma.InputJsonValue
  if (!encryptionConfigured()) return value as Prisma.InputJsonValue
  return encryptSecret(JSON.stringify(value))
}

/** Decrypt a Json-column run value back to its object form (identity for legacy plaintext). */
export function decryptRunValue<T = unknown>(stored: unknown): T | null {
  if (stored === null || stored === undefined) return null
  if (typeof stored === 'string' && CIPHERTEXT.test(stored)) {
    try {
      return JSON.parse(decryptSecret(stored)) as T
    } catch {
      return null
    }
  }
  return stored as T
}

/** Encrypt a plain-text run value (ExecutionMessage.content) for at-rest storage. */
export function encryptRunText(text: string): string {
  if (!encryptionConfigured()) return text
  return encryptSecret(text)
}

/** Decrypt a text run value (identity for legacy plaintext). */
export function decryptRunText(stored: string | null | undefined): string {
  if (!stored) return stored ?? ''
  if (CIPHERTEXT.test(stored)) {
    try {
      return decryptSecret(stored)
    } catch {
      return stored
    }
  }
  return stored
}
