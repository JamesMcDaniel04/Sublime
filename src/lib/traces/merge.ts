/**
 * Per-source keyset pagination for the merged trace stream. A single shared
 * timestamp cursor would re-scan the denser store's tail on every page; a
 * high-water mark PER SOURCE keeps each page two indexed range reads
 * (startedAt desc, id desc — same tiebreak discipline as /api/flows/runs).
 */

export type TraceCursor = { a: [string, string] | null; f: [string, string] | null }

export function encodeCursor(cursor: TraceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** Malformed cursors decode to null → first page (rows may age out; never error). */
export function decodeCursor(raw: string | null): TraceCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const mark = (value: unknown): [string, string] | null =>
      Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string'
        ? [value[0], value[1]]
        : null
    return { a: mark(parsed?.a), f: mark(parsed?.f) }
  } catch {
    return null
  }
}

const after = (x: { startedAt: string; id: string }, y: { startedAt: string; id: string }) =>
  x.startedAt > y.startedAt || (x.startedAt === y.startedAt && x.id > y.id)

/**
 * K-way merge of the two per-source pages, newest first. `next` carries the
 * last CONSUMED row per source; a source the page never reached keeps a null
 * mark — the route re-seeds it from the incoming cursor so that source
 * resumes where its previous page ended, not from the top.
 */
export function mergeTracePages<T extends { startedAt: string; id: string; kind: 'agent' | 'flow' }>(
  agentRows: T[],
  flowRows: T[],
  pageSize: number,
): { rows: T[]; next: TraceCursor | null } {
  const merged: T[] = []
  let ai = 0
  let fi = 0
  while (merged.length < pageSize && (ai < agentRows.length || fi < flowRows.length)) {
    const a = agentRows[ai]
    const f = flowRows[fi]
    if (a && (!f || after(a, f))) {
      merged.push(a)
      ai += 1
    } else if (f) {
      merged.push(f)
      fi += 1
    }
  }
  if (ai >= agentRows.length && fi >= flowRows.length) return { rows: merged, next: null }
  const lastA = ai > 0 ? agentRows[ai - 1] : null
  const lastF = fi > 0 ? flowRows[fi - 1] : null
  return {
    rows: merged,
    next: {
      a: lastA ? [lastA.startedAt, lastA.id] : null,
      f: lastF ? [lastF.startedAt, lastF.id] : null,
    },
  }
}
