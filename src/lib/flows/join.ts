export type JoinStrategy = 'object' | 'array' | 'merge'
export type JoinEntry = { key: string; output: unknown; label?: string }

/**
 * Reconverge parallel branch outputs. `undefined` strategy reproduces today's
 * behaviour EXACTLY — a keyed object { [branchHeadNodeId]: output } — so stored
 * flows are byte-identical. 'array' preserves branch order; 'object' keys by the
 * branch label (falling back to the branch-head id); 'merge' shallow-merges the
 * branch outputs that are plain objects.
 */
export function joinBranchOutputs(entries: JoinEntry[], strategy?: JoinStrategy): unknown {
  if (strategy === 'array') return entries.map((e) => e.output)
  if (strategy === 'merge') {
    const merged: Record<string, unknown> = {}
    for (const e of entries) {
      if (e.output && typeof e.output === 'object' && !Array.isArray(e.output)) Object.assign(merged, e.output as Record<string, unknown>)
    }
    return merged
  }
  return Object.fromEntries(
    entries.map((e) => [strategy === 'object' && e.label?.trim() ? e.label.trim() : e.key, e.output]),
  )
}
