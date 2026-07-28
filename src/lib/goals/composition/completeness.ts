/**
 * How much of a composition is actually bound and readable.
 *
 * `boundPct` answers "is it wired up"; `level` answers "can it be trusted".
 * They diverge deliberately: a fully bound composition with one stale
 * component is 100% bound and still only 'partial', because bound and readable
 * are different claims.
 */
export type CompletenessLevel = 'complete' | 'partial' | 'unbound'

export type CompletenessResult = {
  boundPct: number
  missing: string[]
  stale: string[]
  errored: string[]
  level: CompletenessLevel
}

export function compositionCompleteness(input: {
  required: string[]
  present: string[]
  stale: string[]
  errored: string[]
}): CompletenessResult {
  const required = new Set(input.required)
  // Intersect rather than count raw input: an optional slot being bound must
  // not inflate the required-coverage percentage.
  const present = input.present.filter((slot) => required.has(slot))
  const missing = input.required.filter((slot) => !input.present.includes(slot))
  // Only required slots can compromise a composition; an optional slot going
  // stale is not the goal's problem.
  const stale = input.stale.filter((slot) => required.has(slot))
  const errored = input.errored.filter((slot) => required.has(slot))

  const boundPct =
    required.size === 0 ? 100 : Math.round((present.length / required.size) * 100)

  const healthy =
    missing.length === 0 && stale.length === 0 && errored.length === 0
  const level: CompletenessLevel = healthy
    ? 'complete'
    : present.length === 0 && required.size > 0
      ? 'unbound'
      : 'partial'

  return { boundPct, missing, stale, errored, level }
}
