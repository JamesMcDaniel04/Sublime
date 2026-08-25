import { embedTexts, embedQuery } from '@/lib/rag/embeddings'
import { upsertVectorDocuments, searchVectorDocuments, deleteVectorDocuments } from './store'
import type { RunVectorFn } from '@/features/flows/interpret'

/**
 * The Vector step's adapter: the interpreter's injected `runVector`.
 *
 * Lives here rather than in the interpreter so a flow's control flow stays
 * testable without a database or an embedding API key.
 *
 * Failures are returned as step errors rather than thrown. An embedding
 * provider being down is an ordinary operational condition, and a flow should
 * fail the step — where its onError policy applies — rather than the run
 * dying somewhere with no step attribution.
 */

/** A list, however the template happened to resolve it. */
function asList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  if (value && typeof value === 'object') return [value as Record<string, unknown>]
  return []
}

function field(item: Record<string, unknown>, name: string | undefined, fallbacks: string[]): string | undefined {
  for (const key of [name, ...fallbacks].filter(Boolean) as string[]) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

export function makeRunVector(organizationId: string): RunVectorFn {
  return async (step) => {
    try {
      if (step.mode === 'search') {
        const query = step.query?.trim()
        // An empty query would embed the empty string and return whatever
        // happens to sit nearest the origin — confident nonsense.
        if (!query) return { ok: false, error: 'This search step has no query text.' }

        const hits = await searchVectorDocuments(
          organizationId,
          step.collection,
          await embedQuery(query),
          { limit: step.limit, ...(step.minScore === undefined ? {} : { minScore: step.minScore }) },
        )
        return { ok: true, output: hits }
      }

      const items = asList(step.documents)
      if (items.length === 0) return { ok: true, output: { written: 0, deleted: 0 } }

      if (step.mode === 'delete') {
        const ids = items.map((item) => field(item, step.idField, ['id', 'externalId'])).filter(Boolean) as string[]
        return { ok: true, output: await deleteVectorDocuments(organizationId, step.collection, ids) }
      }

      // upsert
      const prepared = items.map((item) => ({
        externalId: field(item, step.idField, ['id', 'externalId']),
        content: field(item, step.contentField, ['content', 'text', 'body']),
        metadata: item,
      }))

      // Named rather than skipped: silently dropping the items that lacked a
      // field would leave a collection missing documents nobody knows about,
      // and the flow would report success.
      const incomplete = prepared.filter((item) => !item.externalId || !item.content)
      if (incomplete.length > 0) {
        return {
          ok: false,
          error: `${incomplete.length} of ${prepared.length} documents are missing an id or text field. ` +
                 'Set "Which field is the id" and "Which field holds the text" to match your data.',
        }
      }

      // One batched call rather than one per document: embedding is billed per
      // request as well as per token.
      const embeddings = await embedTexts(prepared.map((item) => item.content as string))
      return {
        ok: true,
        output: await upsertVectorDocuments(organizationId, step.collection, prepared.map((item, index) => ({
          externalId: item.externalId as string,
          content: item.content as string,
          embedding: embeddings[index],
          metadata: item.metadata,
        }))),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'The vector step failed.' }
    }
  }
}
