import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { embedTexts, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { chunkText } from './extract'
import { knowledgeCaptureSettings, shouldCaptureKnowledge, type KnowledgeSourceType } from './settings'

export const MAX_KNOWLEDGE_CHARS = 200_000
export const MAX_KNOWLEDGE_CHUNKS = 200

export type KnowledgeVisibility = 'private' | 'agent' | 'organization'

const SENSITIVE_KEY = /(^|_)(authorization|cookie|password|passwd|secret|token|accessToken|refreshToken|apiKey|clientSecret|privateKey)($|_)/i
const INLINE_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g,
  /\b(authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*([^\s,;]+)/gi,
]

function redactInlineSecrets(value: string): string {
  return value
    .replace(INLINE_SECRET_PATTERNS[0], '[REDACTED]')
    .replace(INLINE_SECRET_PATTERNS[1], '[REDACTED]')
    .replace(INLINE_SECRET_PATTERNS[2], (_match, label: string) => `${label}: [REDACTED]`)
}

/** Remove credentials while retaining decision-useful business data. */
export function redactKnowledgeValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]'
  if (typeof value === 'string') return redactInlineSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactKnowledgeValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactKnowledgeValue(nested, depth + 1)
    }
    return output
  }
  return value
}

export function knowledgeText(value: unknown): string {
  if (typeof value === 'string') return redactInlineSecrets(value).trim()
  try {
    return JSON.stringify(redactKnowledgeValue(value), null, 2)
  } catch {
    return redactInlineSecrets(String(value))
  }
}

export function decryptKnowledgeContent(encrypted: string | null | undefined, legacyPlaintext = ''): string {
  if (!encrypted) return legacyPlaintext
  try {
    return decryptSecret(encrypted)
  } catch {
    // Existing rows remain readable during key rotation/deploy transitions.
    return legacyPlaintext
  }
}

export type StoreKnowledgeInput = {
  organizationId: string
  userId?: string | null
  agentId?: string | null
  sourceType: KnowledgeSourceType
  sourceId?: string | null
  title: string
  content: unknown
  filename?: string
  mimeType?: string
  visibility?: KnowledgeVisibility
  provenance?: Record<string, unknown>
  retentionPolicy?: 'workspace' | 'expiring'
  expiresAt?: Date | null
  sizeBytes?: number
}

/**
 * Canonical write path for every retained knowledge source. Writes are
 * idempotent when sourceId is supplied, encrypt both the full body and each
 * chunk, and keep only a blank legacy plaintext chunk for new records.
 */
export async function storeKnowledge(input: StoreKnowledgeInput): Promise<{ stored: boolean; id?: string; chunkCount?: number; createdAt?: Date; reason?: string }> {
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { settings: true },
  })
  const capture = knowledgeCaptureSettings(organization?.settings)
  if (!shouldCaptureKnowledge(capture, input.sourceType)) {
    return { stored: false, reason: capture.zeroDataRetention ? 'zero-data-retention' : 'capture-disabled' }
  }

  const text = knowledgeText(input.content).slice(0, MAX_KNOWLEDGE_CHARS)
  if (!text.trim()) return { stored: false, reason: 'empty' }
  const chunks = chunkText(text).slice(0, MAX_KNOWLEDGE_CHUNKS)
  const now = new Date()
  const contentHash = crypto.createHash('sha256').update(text).digest('hex')
  const bodyEncrypted = encryptSecret(text)

  let embeddings: number[][] | null = null
  if (chunks.length && embeddingsConfigured()) {
    try {
      embeddings = await embedTexts(chunks, { inputType: 'document' })
    } catch {
      embeddings = null
    }
  }

  const common = {
    agentId: input.agentId ?? null,
    userId: input.userId ?? null,
    filename: input.filename || `${input.sourceType}-${input.sourceId || now.toISOString()}.md`,
    title: input.title.slice(0, 300),
    mimeType: input.mimeType || 'text/markdown',
    sizeBytes: input.sizeBytes ?? Buffer.byteLength(text, 'utf8'),
    charCount: text.length,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    visibility: input.visibility ?? 'private',
    contentEncrypted: bodyEncrypted,
    contentHash,
    provenance: (redactKnowledgeValue(input.provenance ?? {}) || {}) as Prisma.InputJsonValue,
    retentionPolicy: input.retentionPolicy ?? 'workspace',
    lastSyncedAt: now,
    expiresAt: input.expiresAt ?? null,
    status: 'ready',
    error: null,
  }

  const doc = await prisma.$transaction(async (tx) => {
    let document
    if (input.sourceId) {
      document = await tx.knowledgeDocument.upsert({
        where: {
          organizationId_sourceType_sourceId: {
            organizationId: input.organizationId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          },
        },
        create: { organizationId: input.organizationId, ...common },
        update: common,
      })
      await tx.knowledgeChunk.deleteMany({ where: { documentId: document.id, organizationId: input.organizationId } })
    } else {
      document = await tx.knowledgeDocument.create({ data: { organizationId: input.organizationId, ...common } })
    }

    if (chunks.length) {
      await tx.knowledgeChunk.createMany({
        data: chunks.map((chunk, ordinal) => ({
          documentId: document.id,
          organizationId: input.organizationId,
          agentId: input.agentId ?? null,
          ordinal,
          // New knowledge is encrypted at the application boundary. The
          // legacy column stays non-null for rolling-deploy compatibility.
          content: '',
          contentEncrypted: encryptSecret(chunk),
        })),
      })
    }
    return document
  })

  if (embeddings?.length) {
    const created = await prisma.knowledgeChunk.findMany({
      where: { documentId: doc.id, organizationId: input.organizationId },
      orderBy: { ordinal: 'asc' },
      select: { id: true },
    })
    const values = created
      .map((row, index) => embeddings?.[index]?.length ? Prisma.sql`(${row.id}::text, ${toSqlVector(embeddings[index])}::vector(1024))` : null)
      .filter((value): value is Prisma.Sql => value !== null)
    if (values.length) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
        await tx.$executeRaw`
          UPDATE "knowledge_chunks" AS c
          SET "embeddingVec" = v.vec
          FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
          WHERE c."id" = v.id AND c."organizationId" = ${input.organizationId}::uuid
        `
      })
    }
  }

  return { stored: true, id: doc.id, chunkCount: chunks.length, createdAt: doc.createdAt }
}
