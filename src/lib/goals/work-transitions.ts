/**
 * The legal moves on a GoalWork row. Pure, so the route and the UI cannot
 * disagree about what is allowed, and so every refusal is unit-testable.
 *
 * The load-bearing rule is that `outcome` belongs only to used or edited
 * items. A skipped item was never sent, so nothing could have landed;
 * recording an outcome on it would place a row in the outcome numerator that
 * was never in its denominator and quietly corrupt the funnel.
 */

export const DISPOSITIONS = ['pending', 'used', 'edited', 'skipped'] as const
export const OUTCOMES = ['unknown', 'worked', 'no_response', 'failed'] as const

export type Disposition = (typeof DISPOSITIONS)[number]
export type Outcome = (typeof OUTCOMES)[number]

export type WorkState = { disposition: Disposition; outcome: Outcome }

export type WorkPatch = {
  disposition?: Disposition
  outcome?: Outcome
  outcomeNote?: string | null
  assigneeUserId?: string | null
  body?: string
  skipReason?: string | null
  skipNote?: string | null
}

/** Dispositions that mean a human actually put the work to use. */
const USED: ReadonlySet<Disposition> = new Set<Disposition>(['used', 'edited'])

/** `null` when the patch is allowed; otherwise the reason to refuse it. */
export function refusePatch(current: WorkState, patch: WorkPatch): string | null {
  if (patch.disposition !== undefined) {
    if (!(DISPOSITIONS as readonly string[]).includes(patch.disposition)) {
      return `Unknown disposition "${patch.disposition}".`
    }
    if (current.disposition === 'skipped') {
      return 'This item was skipped, and skipped is terminal.'
    }
  }

  if (patch.outcome !== undefined) {
    if (!(OUTCOMES as readonly string[]).includes(patch.outcome)) {
      return `Unknown outcome "${patch.outcome}".`
    }
    // Judge against the state this patch LANDS on, not the one it left, so a
    // single call that copies and marks worked succeeds while one that skips
    // and marks worked does not.
    const landing = patch.disposition ?? current.disposition
    if (landing === 'skipped') {
      return 'This item was skipped, so it has no outcome — nothing was sent.'
    }
    if (!USED.has(landing)) {
      return 'Only work someone actually used can have an outcome.'
    }
  }

  return null
}
