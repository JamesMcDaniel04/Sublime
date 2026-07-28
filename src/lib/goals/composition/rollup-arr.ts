/**
 * ARR composition: a signed sum of the four movements over the period's
 * opening balance. Pure, zero I/O.
 *
 * Magnitudes, not signs, are authoritative for contraction and churn: sources
 * disagree about whether churn is reported positive or negative, and a sign
 * flip must not silently turn a loss into a gain.
 */
export const ARR_REQUIRED_SLOTS = [
  'new_arr',
  'expansion_arr',
  'contraction_arr',
  'churned_arr',
] as const

export const ARR_OPTIONAL_SLOTS = ['customers_start', 'customers_churned'] as const

export type ArrRollup = {
  derived: number | null
  present: string[]
  missing: string[]
  netNew: number | null
  nrr: number | null
  grr: number | null
  logoChurn: number | null
}

/** Division that refuses to produce Infinity or NaN from an empty base. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function rollupArr(
  startValue: number,
  components: Map<string, number>,
): ArrRollup {
  const present = ARR_REQUIRED_SLOTS.filter((slot) => components.has(slot))
  const missing = ARR_REQUIRED_SLOTS.filter((slot) => !components.has(slot))

  // Logo churn is independent of the four movements, so it survives an
  // otherwise incomplete composition.
  const customersStart = components.get('customers_start')
  const customersChurned = components.get('customers_churned')
  const logoChurn =
    customersStart === undefined || customersChurned === undefined
      ? null
      : ratio(Math.abs(customersChurned), customersStart)

  if (missing.length > 0) {
    return {
      derived: null,
      present: [...present],
      missing: [...missing],
      netNew: null,
      nrr: null,
      grr: null,
      logoChurn,
    }
  }

  const gained =
    (components.get('new_arr') ?? 0) + (components.get('expansion_arr') ?? 0)
  const lost =
    Math.abs(components.get('contraction_arr') ?? 0) +
    Math.abs(components.get('churned_arr') ?? 0)
  const expansion = components.get('expansion_arr') ?? 0
  const netNew = gained - lost

  return {
    derived: startValue + netNew,
    present: [...present],
    missing: [],
    netNew,
    // Retention ratios describe the existing book, so new_arr is excluded.
    nrr: ratio(startValue + expansion - lost, startValue),
    grr: ratio(startValue - lost, startValue),
    logoChurn,
  }
}
