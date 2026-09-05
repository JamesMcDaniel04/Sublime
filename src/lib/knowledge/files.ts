/**
 * The workspace file repository: Markdown notes and uploaded documents a
 * team keeps for its agents to reference by name.
 *
 * This is the same durable substrate as retained knowledge (KnowledgeDocument
 * + chunks, encrypted, embedded, retrieved into prompts by similarity) — a
 * repository file is a document whose sourceType is `upload` or `manual`.
 * What this module adds is DIRECT access: a viewer lists and reads whole
 * files on /knowledge, and an agent lists and reads them through the
 * list_workspace_files / read_workspace_file tools instead of hoping the
 * right passage is retrieved. Auto-captured knowledge (run summaries,
 * connection profiles) is deliberately excluded from that surface: it is
 * background context, not a file someone put there to be read.
 */
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { agentReadScope } from '@/lib/server/visibility'
import { decryptKnowledgeContent, storeKnowledge, type KnowledgeVisibility } from './store'

/** Source types that count as "a file in the repository". */
export const REPOSITORY_SOURCE_TYPES = ['upload', 'manual'] as const
export type RepositorySourceType = (typeof REPOSITORY_SOURCE_TYPES)[number]

/** A single tool read returns at most this many characters; longer files page by `offset`. */
export const MAX_FILE_READ_CHARS = 24_000
/** Cap on the roster an agent sees — enough for any real repository, bounded for the prompt. */
export const MAX_LISTED_FILES = 100

export type WorkspaceFileSummary = {
  id: string
  title: string
  filename: string
  sourceType: string
  mimeType: string
  visibility: string
  sizeBytes: number
  charCount: number
  updatedAt: Date
}

function isRepositorySource(sourceType: string): sourceType is RepositorySourceType {
  return (REPOSITORY_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

/**
 * The documents a RUN may read: workspace-wide files, files attached to this
 * agent, and the running user's private files — the same rule
 * retrieveKnowledge applies to passages, so a file an agent can read is a
 * file whose passages it could already have been shown.
 */
export function agentFileScope(params: { organizationId: string; agentId: string; userId?: string | null }): Prisma.KnowledgeDocumentWhereInput {
  return {
    organizationId: params.organizationId,
    status: 'ready',
    sourceType: { in: [...REPOSITORY_SOURCE_TYPES] },
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
    OR: [
      { visibility: 'organization' },
      { visibility: 'agent', agentId: params.agentId },
      ...(params.userId ? [{ visibility: 'private', userId: params.userId }] : []),
    ],
  }
}

/**
 * The documents a VIEWER may see on /knowledge: workspace-wide files, their
 * own, and files attached to agents they can read. Shared by the collection
 * and single-document routes so a document listed is always a document that
 * opens.
 */
export async function viewerKnowledgeScope(organizationId: string, userId: string): Promise<Prisma.KnowledgeDocumentWhereInput> {
  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: { not: 'DELETED' }, ...agentReadScope(userId) },
    select: { id: true },
  })
  return {
    organizationId,
    OR: [
      { visibility: 'organization' },
      { userId },
      { visibility: 'agent', agentId: { in: agents.map((agent) => agent.id) } },
    ],
  }
}

const SUMMARY_SELECT = {
  id: true, title: true, filename: true, sourceType: true, mimeType: true,
  visibility: true, sizeBytes: true, charCount: true, updatedAt: true,
} as const

function toSummary(row: { id: string; title: string | null; filename: string; sourceType: string; mimeType: string; visibility: string; sizeBytes: number; charCount: number; updatedAt: Date }): WorkspaceFileSummary {
  return { ...row, title: row.title || row.filename }
}

export async function listWorkspaceFiles(scope: Prisma.KnowledgeDocumentWhereInput, limit = MAX_LISTED_FILES): Promise<WorkspaceFileSummary[]> {
  const rows = await prisma.knowledgeDocument.findMany({
    where: scope,
    orderBy: { updatedAt: 'desc' },
    select: SUMMARY_SELECT,
    take: limit,
  })
  return rows.map(toSummary)
}

/**
 * Resolve a model-supplied reference — an id, a filename, or a title — to
 * one file. Exact (case-insensitive) matches win; a unique prefix or
 * substring match is accepted so "onboarding" finds "onboarding-guide.md";
 * an ambiguous reference resolves to nothing rather than to a guess.
 */
export function resolveFileRef<T extends { id: string; filename: string; title: string }>(files: T[], ref: string): { file: T | null; candidates: T[] } {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) return { file: null, candidates: [] }
  const byId = files.find((file) => file.id === ref.trim())
  if (byId) return { file: byId, candidates: [byId] }
  const exact = files.filter((file) => file.filename.toLowerCase() === wanted || file.title.toLowerCase() === wanted)
  if (exact.length === 1) return { file: exact[0], candidates: exact }
  if (exact.length > 1) return { file: null, candidates: exact }
  const partial = files.filter((file) => file.filename.toLowerCase().includes(wanted) || file.title.toLowerCase().includes(wanted))
  return partial.length === 1 ? { file: partial[0], candidates: partial } : { file: null, candidates: partial }
}

/** Slice a file body for one tool read, reporting where the next read should start. */
export function pageContent(content: string, offset = 0, maxChars = MAX_FILE_READ_CHARS): { content: string; offset: number; totalChars: number; truncated: boolean; nextOffset: number | null } {
  const start = Math.max(0, Math.min(Math.trunc(offset) || 0, content.length))
  const size = Math.max(1, Math.min(Math.trunc(maxChars) || MAX_FILE_READ_CHARS, MAX_FILE_READ_CHARS))
  const end = Math.min(content.length, start + size)
  const truncated = end < content.length
  return { content: content.slice(start, end), offset: start, totalChars: content.length, truncated, nextOffset: truncated ? end : null }
}

/** Load one file's decrypted body within a scope; null when it is not visible. */
export async function readWorkspaceFile(scope: Prisma.KnowledgeDocumentWhereInput, id: string): Promise<(WorkspaceFileSummary & { content: string; editable: boolean; createdAt: Date; userId: string | null }) | null> {
  const row = await prisma.knowledgeDocument.findFirst({
    where: { ...scope, id },
    select: { ...SUMMARY_SELECT, contentEncrypted: true, createdAt: true, userId: true },
  })
  if (!row) return null
  const { contentEncrypted, ...rest } = row
  return {
    ...toSummary(rest),
    createdAt: row.createdAt,
    userId: row.userId,
    content: decryptKnowledgeContent(contentEncrypted),
    editable: isRepositorySource(row.sourceType),
  }
}

/**
 * Rewrite a repository file in place — new body and/or title — keeping its
 * id, so links and agent references survive an edit. The document is keyed
 * to itself (sourceId = id) on first edit; storeKnowledge's upsert then
 * re-chunks and re-embeds the new body under the same row.
 */
export async function updateWorkspaceFile(params: {
  organizationId: string
  id: string
  title?: string
  content?: string
  visibility?: KnowledgeVisibility
}): Promise<{ ok: true } | { ok: false; reason: 'not-found' | 'not-editable' | 'empty' | 'disabled' }> {
  const row = await prisma.knowledgeDocument.findFirst({
    where: { id: params.id, organizationId: params.organizationId },
    select: { id: true, sourceType: true, sourceId: true, title: true, filename: true, mimeType: true, agentId: true, userId: true, visibility: true, provenance: true, contentEncrypted: true },
  })
  if (!row) return { ok: false, reason: 'not-found' }
  if (!isRepositorySource(row.sourceType)) return { ok: false, reason: 'not-editable' }
  const content = params.content ?? decryptKnowledgeContent(row.contentEncrypted)
  if (!content.trim()) return { ok: false, reason: 'empty' }
  if (row.sourceId !== row.id) {
    await prisma.knowledgeDocument.update({ where: { id: row.id, organizationId: params.organizationId }, data: { sourceId: row.id } })
  }
  const stored = await storeKnowledge({
    organizationId: params.organizationId,
    agentId: row.agentId,
    userId: row.userId,
    sourceType: row.sourceType,
    sourceId: row.id,
    title: params.title?.trim() || row.title || row.filename,
    filename: row.filename,
    mimeType: row.mimeType,
    content,
    visibility: params.visibility ?? (row.visibility as KnowledgeVisibility),
    provenance: { ...((row.provenance as Record<string, unknown>) ?? {}), editedAt: new Date().toISOString() },
  })
  return stored.stored ? { ok: true } : { ok: false, reason: 'disabled' }
}

/** Create a Markdown note authored in the app (no upload). */
export async function createWorkspaceNote(params: {
  organizationId: string
  userId: string
  title: string
  content: string
  visibility: KnowledgeVisibility
}): Promise<{ id: string; chunkCount: number } | null> {
  const title = params.title.trim()
  const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'note'}.md`
  const stored = await storeKnowledge({
    organizationId: params.organizationId,
    userId: params.userId,
    sourceType: 'manual',
    title,
    filename,
    mimeType: 'text/markdown',
    content: params.content,
    visibility: params.visibility,
    provenance: { kind: 'note' },
  })
  return stored.stored && stored.id ? { id: stored.id, chunkCount: stored.chunkCount ?? 0 } : null
}
