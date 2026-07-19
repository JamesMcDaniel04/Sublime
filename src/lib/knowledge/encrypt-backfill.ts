import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { encryptSecret, decryptSecret, encryptionConfigured } from '@/lib/crypto/secrets'

/**
 * Nightly encryption backfill for the knowledge substrate: pre-cutover chunk
 * rows still carry plaintext in the legacy `content` column (with no
 * `contentEncrypted`), and rows written while ENCRYPTION_KEY was unset carry
 * the reversible `b64:` fallback. Both violate the "private, encrypted
 * knowledge" contract at rest, so this sweep converges them onto AES-256-GCM:
 *
 *   1. plaintext rows  → contentEncrypted = encrypt(content), content = ''
 *   2. b64 rows        → contentEncrypted re-encrypted with the real key
 *
 * Gated on a real key being configured (the b64 fallback is NOT encryption,
 * so running without a key would be pointless churn). Bounded per sweep;
 * per-row failures are logged and retried on a later night. Never throws.
 */

const DEFAULT_CAP = 200

export type BackfillResult = { encrypted: number; upgraded: number } | { skipped: string }

export async function encryptLegacyKnowledge(db = systemPrisma, cap = DEFAULT_CAP): Promise<BackfillResult> {
  if (!encryptionConfigured()) return { skipped: 'encryption-not-configured' }
  try {
    // systemPrisma: global encryption-hygiene sweep — converges rows across
    // all orgs by design (invoked only from the CRON_SECRET-gated retention
    // cron); every write below is id+organizationId-keyed.
    const [plaintextRows, b64Rows] = await Promise.all([
      db.knowledgeChunk.findMany({
        where: { contentEncrypted: null, content: { not: '' } },
        select: { id: true, organizationId: true, content: true },
        take: cap,
      }),
      db.knowledgeChunk.findMany({
        where: { contentEncrypted: { startsWith: 'b64:' } },
        select: { id: true, organizationId: true, contentEncrypted: true },
        take: cap,
      }),
    ])

    let encrypted = 0
    for (const row of plaintextRows) {
      try {
        await db.knowledgeChunk.update({
          where: { id: row.id, organizationId: row.organizationId },
          data: { contentEncrypted: encryptSecret(row.content), content: '' },
        })
        encrypted += 1
      } catch (error) {
        apiLogger.warn('encryptLegacyKnowledge: plaintext row failed; will retry', {
          chunkId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    let upgraded = 0
    for (const row of b64Rows) {
      try {
        const plaintext = decryptSecret(row.contentEncrypted as string)
        await db.knowledgeChunk.update({
          where: { id: row.id, organizationId: row.organizationId },
          data: { contentEncrypted: encryptSecret(plaintext), content: '' },
        })
        upgraded += 1
      } catch (error) {
        apiLogger.warn('encryptLegacyKnowledge: b64 upgrade failed; will retry', {
          chunkId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (plaintextRows.length === cap || b64Rows.length === cap) {
      apiLogger.info('encryptLegacyKnowledge: cap reached, more rows remain for the next sweep', { cap })
    }
    return { encrypted, upgraded }
  } catch (error) {
    apiLogger.warn('encryptLegacyKnowledge failed', { error: error instanceof Error ? error.message : String(error) })
    return { skipped: 'error' }
  }
}
