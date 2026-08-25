/**
 * Merge — joining two branches back together.
 *
 * The one n8n core node Sublime had no workaround for. `parallel` and `router`
 * fan work OUT; nothing fanned it back IN, so a flow that queried two systems
 * and wanted one combined result had to end in a code step, which loses the
 * step-level visibility that is the point of a flow.
 *
 * Pure over two already-resolved branch outputs. The interpreter decides WHICH
 * two (see the merge case in interpret.ts); this decides only what joining
 * them means, so every mode is unit-testable without a run.
 */

export const MERGE_MODES = ['append', 'byKey', 'byPosition', 'pickBranch'] as const
export type MergeMode = (typeof MERGE_MODES)[number]

export type JoinKind = 'inner' | 'left' | 'outer'

export interface MergeConfig {
  mode: MergeMode
  /** byKey: field on the left branch. */
  leftKey?: string
  /** byKey: field on the right branch. Defaults to `leftKey`. */
  rightKey?: string
  join?: JoinKind
}

export type MergeResult = unknown[] | { error: string }

/** A branch output as a list: a non-list value is one item, absent is none. */
function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * Merge two records. LEFT WINS on a collision — the left branch is the one the
 * author wired first, and preferring the right would make the result depend on
 * edge insertion order, which is invisible in the builder.
 */
const combine = (left: unknown, right: unknown): unknown =>
  isRecord(left) && isRecord(right) ? { ...right, ...left } : (left ?? right)

export function runMerge(config: MergeConfig, leftBranch: unknown, rightBranch: unknown): MergeResult {
  const left = asList(leftBranch)
  const right = asList(rightBranch)

  if (config.mode === 'append') return [...left, ...right]

  if (config.mode === 'byPosition') {
    // Stops at the shorter branch: padding with undefined would produce rows
    // that look real and carry half their fields.
    const length = Math.min(left.length, right.length)
    return Array.from({ length }, (_, index) => combine(left[index], right[index]))
  }

  if (config.mode === 'pickBranch') {
    // Whichever branch produced something. Left wins when both did, for the
    // same reason it wins a field collision.
    return left.length > 0 ? left : right
  }

  if (config.mode === 'byKey') {
    const leftKey = config.leftKey?.trim()
    const rightKey = config.rightKey?.trim() || leftKey
    if (!leftKey || !rightKey) {
      return { error: 'Merge needs a field to join on — set the key for each branch.' }
    }

    const join: JoinKind = config.join ?? 'inner'
    // Index the right branch once. A key present on several right rows keeps
    // all of them: duplicate keys are a real shape in CRM exports, and
    // silently keeping the first would drop data without saying so.
    const index = new Map<string, unknown[]>()
    for (const row of right) {
      if (!isRecord(row)) continue
      const value = row[rightKey]
      // An absent key is NOT a joinable value — two undefined keys must not
      // match each other, or every unkeyed row joins every other one.
      if (value === undefined || value === null) continue
      const id = String(value)
      index.set(id, [...(index.get(id) ?? []), row])
    }

    const out: unknown[] = []
    const matchedRight = new Set<unknown>()

    for (const row of left) {
      const value = isRecord(row) ? row[leftKey] : undefined
      const matches = value === undefined || value === null ? [] : index.get(String(value)) ?? []
      if (matches.length > 0) {
        for (const match of matches) {
          out.push(combine(row, match))
          matchedRight.add(match)
        }
      } else if (join === 'left' || join === 'outer') {
        out.push(row)
      }
    }

    if (join === 'outer') {
      for (const row of right) if (!matchedRight.has(row)) out.push(row)
    }

    return out
  }

  // An unrecognised mode is an error rather than a silent append: quietly
  // producing a plausible-looking result is how a misconfigured merge ships.
  return { error: `Merge does not understand the mode "${String(config.mode)}".` }
}
