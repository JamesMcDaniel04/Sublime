/**
 * Scoring a case, and summarising a run.
 *
 * The existing `src/lib/eval` harness is a good developer tool — scripted
 * fixtures, a judge, a CLI. What it is not is a product feature: no datasets,
 * no persisted runs, no way for anyone to ask "did that prompt change make the
 * agent better". Agents make non-deterministic decisions and there was no
 * product-level answer to that question at all.
 *
 * This is the pure half — deciding whether one output passes, and turning a
 * set of outcomes into a verdict. Kept out of the runner so both are testable
 * and so a scoring change cannot quietly depend on how a run was executed.
 */

export interface CaseCheck {
  /** Substrings the output must contain. Cheap, deterministic, no model call. */
  mustContain: string[]
  /** 0..1 from a judge, when one ran. */
  judgeScore?: number
}

export interface CaseVerdict {
  passed: boolean
  score?: number
  notes: string
}

/** A judge score at or above this is a pass. */
export const JUDGE_PASS_THRESHOLD = 0.7

/**
 * Did this output pass?
 *
 * Deterministic checks are AUTHORITATIVE: if a required substring is missing,
 * the case fails no matter how the judge scored it. A model that reasons its
 * way to a confident wrong answer is exactly the failure evaluation exists to
 * catch, and letting a judge overrule a concrete missing value would hide it.
 *
 * The judge only decides cases the deterministic checks cannot.
 */
export function scoreCase(output: string, check: CaseCheck): CaseVerdict {
  const text = output ?? ''
  const missing = check.mustContain
    .map((needle) => needle.trim())
    .filter(Boolean)
    .filter((needle) => !text.toLowerCase().includes(needle.toLowerCase()))

  if (missing.length > 0) {
    return {
      passed: false,
      ...(check.judgeScore !== undefined ? { score: check.judgeScore } : {}),
      notes: `Missing required content: ${missing.join(', ')}`,
    }
  }

  if (check.judgeScore !== undefined) {
    const passed = check.judgeScore >= JUDGE_PASS_THRESHOLD
    return {
      passed,
      score: check.judgeScore,
      notes: passed ? 'Judge accepted the answer.' : `Judge scored ${check.judgeScore.toFixed(2)}, below ${JUDGE_PASS_THRESHOLD}.`,
    }
  }

  // No judge and nothing required: there is nothing to fail on. Reported as a
  // pass with a note, rather than silently, so an empty rubric is visible as a
  // weak case rather than a green one.
  return {
    passed: true,
    notes: check.mustContain.length === 0 ? 'No checks configured for this case.' : 'All required content present.',
  }
}

export interface RunSummary {
  passed: number
  failed: number
  total: number
  /** 0..1. `null` when there are no cases — NOT 1, which would read as perfect. */
  passRate: number | null
  /** Mean judge score across cases that had one. */
  averageScore: number | null
}

export function summarizeRun(verdicts: CaseVerdict[]): RunSummary {
  const passed = verdicts.filter((verdict) => verdict.passed).length
  const failed = verdicts.length - passed
  const scored = verdicts.map((verdict) => verdict.score).filter((score): score is number => typeof score === 'number')

  return {
    passed,
    failed,
    total: verdicts.length,
    // An empty run is not a perfect run. Returning 1 here would put a green
    // 100% next to a dataset nobody has written cases for.
    passRate: verdicts.length === 0 ? null : passed / verdicts.length,
    averageScore: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
  }
}

/**
 * Did the agent get better or worse between two runs?
 *
 * Compares pass RATE rather than count, because a dataset grows: six of ten
 * passing is not worse than five of five, and a raw count would report it as
 * a regression the first time someone adds a case.
 */
export function compareRuns(previous: RunSummary, current: RunSummary): 'improved' | 'regressed' | 'unchanged' | 'unknown' {
  if (previous.passRate === null || current.passRate === null) return 'unknown'
  if (current.passRate > previous.passRate) return 'improved'
  if (current.passRate < previous.passRate) return 'regressed'
  return 'unchanged'
}
