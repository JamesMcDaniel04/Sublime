/**
 * Unified context assembly for agent runs.
 *
 * Three retrieval systems feed the system prompt independently — graph-RAG
 * correlated context, uploaded-file knowledge chunks, and agent memory. Each
 * ranked internally, but nothing bounded the combined size or removed
 * cross-system duplicates (an enriched account status can arrive via graph
 * hit AND a remembered learning). These pure helpers give the caller one
 * budget and one dedupe pass while keeping each system's own renderer (whose
 * instructions — citations, source attribution — stay authoritative).
 */

/** ~8k tokens of combined retrieved context (chars ≈ tokens × 4). */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 32_000

/**
 * Keep the highest-scored items whose combined text fits `budgetChars`,
 * preserving the caller's original ordering among the survivors (renderers
 * rely on their own ordering semantics). Unscored items rank last.
 */
export function capByBudget<T>(
  items: T[],
  textOf: (item: T) => string,
  scoreOf: (item: T) => number | undefined,
  budgetChars: number,
): T[] {
  if (items.length === 0) return items
  const ranked = items
    .map((item, index) => ({ item, index, score: scoreOf(item) ?? -Infinity, chars: textOf(item).length }))
    .sort((a, b) => b.score - a.score)
  const keptIndexes = new Set<number>()
  let used = 0
  for (const candidate of ranked) {
    if (used + candidate.chars > budgetChars) continue
    used += candidate.chars
    keptIndexes.add(candidate.index)
  }
  return items.filter((_, index) => keptIndexes.has(index))
}

/** Cheap near-duplicate key: lowercased, whitespace-collapsed leading slice. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)
}

/**
 * Cross-system dedupe: systems are processed in priority order; an item whose
 * normalized text was already emitted by an earlier system (or earlier in its
 * own list) is dropped. Returns the filtered lists in the same order.
 */
export function dedupeAcrossSystems<T>(systems: T[][], textOf: (item: T) => string): T[][] {
  const seen = new Set<string>()
  return systems.map((items) =>
    items.filter((item) => {
      const key = dedupeKey(textOf(item))
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    }),
  )
}

/**
 * Incremental façade over capByBudget + dedupe for call sites that retrieve
 * system-by-system (execute-agent's three sequential blocks): each `take`
 * dedupes against everything already taken, then caps against the remaining
 * shared budget. Earlier systems therefore have priority — call order is the
 * ranking policy.
 */
export function createContextAssembler(budgetChars: number = DEFAULT_CONTEXT_BUDGET_CHARS) {
  const seen = new Set<string>()
  let remaining = budgetChars
  return {
    take<T>(items: T[], textOf: (item: T) => string, scoreOf: (item: T) => number | undefined): T[] {
      const fresh = items.filter((item) => {
        const key = dedupeKey(textOf(item))
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      const kept = capByBudget(fresh, textOf, scoreOf, remaining)
      remaining -= kept.reduce((sum, item) => sum + textOf(item).length, 0)
      return kept
    },
    remaining: () => remaining,
  }
}
