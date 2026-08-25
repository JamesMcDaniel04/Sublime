/**
 * Flow static data — state that survives between runs.
 *
 * n8n gives every workflow a persistent key-value store
 * (`$getWorkflowStaticData`); it is how polling triggers remember cursors and
 * how flows dedupe across executions. Sublime had exactly one special case of
 * it — the poll trigger's private cursor — so "only act on rows I have not
 * seen before" could not be expressed at all.
 *
 * This module is the PURE half: given what a flow has already seen, which of
 * these items are new? The store lives in features/flows/static-store.ts, so
 * the rule is testable without a database and the storage can change without
 * touching the semantics.
 */
import { createHash } from 'node:crypto'

/**
 * How many identities a flow remembers.
 *
 * The set is stored on the flow row, so an unbounded one grows forever and
 * eventually makes every run read a large blob to answer one question. Five
 * thousand covers "did I see this in the last few weeks" for realistic poll
 * volumes; beyond that the honest answer is that a flow needs a real cursor,
 * not a memory of everything.
 */
export const MAX_SEEN_KEYS = 5_000

/** Stable JSON: keys sorted, so a hash does not depend on property order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`
}

/**
 * The identity of an item for dedupe purposes.
 *
 * Uses `idPath` when the item carries it; otherwise hashes the whole item.
 * The hash is over a STABLE serialization because a Json column does not
 * preserve key order — a hash that depended on it would report the same row
 * as new on every single run, which is the failure mode that makes people
 * distrust dedupe entirely.
 */
export function identityOf(item: unknown, idPath: string): string {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const value = (item as Record<string, unknown>)[idPath]
    if (value !== undefined && value !== null) return String(value)
  }
  return `#${createHash('sha1').update(stableStringify(item)).digest('hex').slice(0, 24)}`
}

export interface UnseenPartition {
  /** Items not seen before, in source order. */
  fresh: unknown[]
  /** Identities of `fresh`, to be recorded once the run commits. */
  identities: string[]
}

/**
 * Split a batch into the items this flow has not seen.
 *
 * A duplicate WITHIN the batch is emitted once: otherwise the first copy is
 * recorded and the second slips through as new on the following run, which
 * looks exactly like dedupe not working.
 */
export function partitionUnseen(items: unknown[], idPath: string, seen: Iterable<string>): UnseenPartition {
  const known = new Set(seen)
  const fresh: unknown[] = []
  const identities: string[] = []
  for (const item of items) {
    const id = identityOf(item, idPath)
    if (known.has(id)) continue
    known.add(id)
    fresh.push(item)
    identities.push(id)
  }
  return { fresh, identities }
}

/**
 * Bound the seen set, keeping the MOST RECENT identities.
 *
 * Keeping the oldest would re-emit the rows a flow just processed, which is
 * the opposite of what dedupe is for. Duplicates collapse to their last
 * occurrence so recency is meaningful.
 */
export function boundSeen(keys: string[]): string[] {
  const deduped = [...new Set([...keys].reverse())].reverse()
  return deduped.length <= MAX_SEEN_KEYS ? deduped : deduped.slice(deduped.length - MAX_SEEN_KEYS)
}
