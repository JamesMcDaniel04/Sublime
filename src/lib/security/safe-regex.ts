/**
 * ReDoS guard for user/template-supplied regular expressions.
 *
 * The flow `matches` condition operator compiles a pattern that can come from
 * a flow author OR from templated upstream data (a webhook payload, an LLM
 * output). A catastrophic-backtracking pattern there hangs the worker thread
 * for the life of the run — JavaScript regex execution is a single
 * uninterruptible C++ call, so no timeout, AbortSignal, or vm interrupt can
 * reclaim it. The only defense available in-process is to refuse to compile
 * patterns whose structure permits exponential backtracking.
 *
 * Two structural rejections, both targeting the shapes that actually blow up:
 *
 *   1. Star height >= 2 — an unbounded quantifier applied to a group that
 *      itself contains one: /(a+)+$/, /(\d*\w*)*$/. The classic ReDoS shape.
 *   2. Quantified alternation with overlapping branch prefixes — /(a|ab)*$/,
 *      /(x|x)+/. Star height is only 1, but ambiguity between branches gives
 *      the engine exponentially many ways to split the same input. Branches
 *      with provably disjoint first-characters (/(foo|bar)+/) are ambiguity
 *      free and stay allowed, which keeps the common legitimate cases working.
 *
 * Plus length caps on both pattern and subject: polynomial (non-exponential)
 * backtracking still costs O(n^2)-ish, so bounding n bounds the damage.
 *
 * This is deliberately conservative in the safe direction — a rejected pattern
 * returns false from the operator (and logs), it never executes. If the app
 * ever gains a true linear-time engine (RE2/WASM), this module is the seam to
 * swap: keep the signature, drop the structural analysis.
 */

/** Longest accepted pattern source. Beyond this, analysis cost itself matters. */
export const MAX_PATTERN_LENGTH = 1_000
/** Longest subject string tested. Bounds polynomial-backtracking blowup. */
export const MAX_SUBJECT_LENGTH = 100_000

export class UnsafeRegexError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'UnsafeRegexError'
  }
}

/** An unbounded quantifier — the only kind that permits exponential blowup. */
function unboundedQuantifierAt(source: string, index: number): { length: number } | null {
  const char = source[index]
  if (char === '*' || char === '+') return { length: 1 }
  // {n,} with no upper bound. {n,m} is bounded, so it cannot blow up.
  if (char === '{') {
    const close = source.indexOf('}', index)
    if (close === -1) return null
    const spec = source.slice(index + 1, close)
    if (/^\d+,\s*$/.test(spec)) return { length: close - index + 1 }
    return null
  }
  return null
}

/**
 * First-character sets of each top-level alternation branch, or null when a
 * branch's opening construct is too complex to reason about (nested group,
 * backreference, lookaround) — null means "assume ambiguous", the safe answer.
 */
function branchFirstChars(branch: string): Set<string> | null {
  if (!branch) return null // empty branch matches everything ambiguously
  const char = branch[0]
  if (char === '\\') {
    const next = branch[1]
    if (!next) return null
    // Character classes (\d, \w, \s) overlap in ways not worth enumerating.
    if (/[dDwWsSbB]/.test(next)) return null
    return new Set([next])
  }
  if (char === '[') {
    const close = branch.indexOf(']', branch[1] === '^' || branch[1] === ']' ? 2 : 1)
    if (close === -1) return null
    const body = branch.slice(1, close)
    if (body.startsWith('^') || body.includes('-') || body.includes('\\')) return null
    return new Set(body.split(''))
  }
  // A nested group, quantifier, anchor, or wildcard: not analyzable cheaply.
  if ('(){}*+?|.^$'.includes(char)) return null
  return new Set([char])
}

/** True when any two branches can begin with the same character. */
function branchesAreAmbiguous(branches: string[]): boolean {
  const seen = new Set<string>()
  for (const branch of branches) {
    const first = branchFirstChars(branch)
    if (first === null) return true
    for (const char of first) {
      if (seen.has(char)) return true
      seen.add(char)
    }
  }
  return false
}

type GroupFrame = {
  /** Offset just past the group's opening paren, for slicing its body. */
  bodyStart: number
  /** An unbounded quantifier appeared at this nesting level. */
  hasUnboundedQuantifier: boolean
  /** Offsets of top-level `|` within this group, for branch extraction. */
  alternationSplits: number[]
}

/**
 * Throw when `source` has a structure that permits catastrophic backtracking.
 * Pure structural analysis — never executes the pattern.
 */
export function assertSafeRegexSource(source: string): void {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new UnsafeRegexError(`Pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit.`)
  }

  const stack: GroupFrame[] = [{ bodyStart: 0, hasUnboundedQuantifier: false, alternationSplits: [] }]
  let inCharClass = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]

    if (char === '\\') {
      i++ // skip the escaped character; it can never open a group or quantify
      continue
    }
    if (inCharClass) {
      if (char === ']') inCharClass = false
      continue
    }
    if (char === '[') {
      inCharClass = true
      continue
    }
    if (char === '(') {
      stack.push({ bodyStart: i + 1, hasUnboundedQuantifier: false, alternationSplits: [] })
      continue
    }
    if (char === '|') {
      stack[stack.length - 1].alternationSplits.push(i)
      continue
    }
    if (char === ')') {
      // Unbalanced source: let the RegExp constructor produce the real error.
      if (stack.length === 1) continue
      const frame = stack.pop()!
      const quantifier = unboundedQuantifierAt(source, i + 1)
      if (quantifier) {
        if (frame.hasUnboundedQuantifier) {
          throw new UnsafeRegexError(
            'Pattern nests an unbounded quantifier inside a quantified group (e.g. "(a+)+"), which can backtrack exponentially.',
          )
        }
        if (frame.alternationSplits.length > 0) {
          const body = source.slice(frame.bodyStart, i)
          // Splits are absolute offsets; rebase them onto the sliced body.
          const relative = frame.alternationSplits.map((at) => at - frame.bodyStart)
          const branches: string[] = []
          let start = 0
          for (const at of relative) {
            branches.push(body.slice(start, at))
            start = at + 1
          }
          branches.push(body.slice(start))
          // A non-capturing/lookaround prefix shifts the real body start.
          const normalized = branches.map((branch, index) =>
            index === 0 ? branch.replace(/^\?(?::|<?[=!]|<[A-Za-z_$][\w$]*>)/, '') : branch,
          )
          if (branchesAreAmbiguous(normalized)) {
            throw new UnsafeRegexError(
              'Pattern quantifies an alternation whose branches can start with the same character (e.g. "(a|ab)*"), which can backtrack exponentially.',
            )
          }
        }
        i += quantifier.length - 1
      }
      // A group's contents are also contents of its parent, so an unbounded
      // quantifier anywhere inside must bubble up even through an unquantified
      // wrapper — otherwise "((b+))+" reads as star height 1 and slips past.
      if (frame.hasUnboundedQuantifier || quantifier) {
        stack[stack.length - 1].hasUnboundedQuantifier = true
      }
      continue
    }

    const quantifier = unboundedQuantifierAt(source, i)
    if (quantifier) {
      stack[stack.length - 1].hasUnboundedQuantifier = true
      i += quantifier.length - 1
    }
  }
}

/**
 * Compile `source` after the safety check. Throws UnsafeRegexError for a
 * structurally dangerous pattern, SyntaxError for an invalid one.
 */
export function safeRegex(source: string, flags?: string): RegExp {
  assertSafeRegexSource(source)
  return new RegExp(source, flags)
}

/**
 * Test `subject` against `source`, refusing dangerous patterns and truncating
 * oversized subjects. Returns false (never throws) when the pattern is unsafe
 * or invalid, so a condition operator can treat it as "did not match".
 */
export function safeRegexTest(source: string, subject: string): boolean {
  try {
    const re = safeRegex(source)
    return re.test(subject.length > MAX_SUBJECT_LENGTH ? subject.slice(0, MAX_SUBJECT_LENGTH) : subject)
  } catch {
    return false
  }
}
