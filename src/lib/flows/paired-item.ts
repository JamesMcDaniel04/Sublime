/**
 * Paired-item lineage — which item of an earlier step's output corresponds to
 * the item currently being processed.
 *
 * This is what n8n expressions like `$('Resolve Channel').item.json.id` do,
 * and the gap it closes is real: without it a loop body can read an earlier
 * step's whole output but cannot line it up with the item in hand, which is
 * the most common thing a per-item flow needs.
 *
 * **The rule that makes it safe: a pairing is known or it is absent.** Where
 * correspondence cannot be established this returns undefined rather than
 * guessing. A wrong item is far worse than no item — the flow keeps running,
 * looks healthy, and acts on another record's data. A missing value shows up
 * immediately as an empty field.
 */

export interface IterationPosition {
  index: number
  count: number
}

/** A step's recorded outputs, as the interpreter keeps them. */
export interface PairableStep {
  output?: unknown
  /**
   * One output per loop iteration, for a step INSIDE the loop body. When
   * present this is exact lineage and always wins over positional inference.
   */
  outputByIteration?: Record<number, unknown>
}

export function pairedItemFor(step: unknown, position: IterationPosition | undefined): unknown {
  if (!step || typeof step !== 'object') return undefined
  const record = step as PairableStep

  // 1. Exact lineage. A step that ran inside this loop body produced one
  //    output per iteration, so there is nothing to infer.
  if (record.outputByIteration && position) {
    // A step present but with no entry for THIS iteration did not run here.
    // Falling through to positional inference would pair the current item
    // with an unrelated step's array — precisely the silent-wrong-item case.
    return Object.prototype.hasOwnProperty.call(record.outputByIteration, position.index)
      ? record.outputByIteration[position.index]
      : undefined
  }

  if (!('output' in record)) return undefined
  const output = record.output

  // 2. Outside a loop there is no current item to pair with. A single value is
  //    the whole answer; an array has no ONE corresponding item, and taking
  //    the first would be a guess dressed as a result.
  if (!position) return Array.isArray(output) ? undefined : output

  // 3. A non-array output inside a loop is shared by every iteration — a
  //    lookup table or a config blob fetched once before the loop. That is
  //    genuinely the corresponding value for each item.
  if (!Array.isArray(output)) return output

  // 4. Positional pairing, and only when the arrays actually line up.
  //    Different lengths have no defensible correspondence: pairing item 2 of
  //    a 3-item loop with item 2 of a 4-item array is a coincidence, not a
  //    lineage, and acting on it means emailing the wrong customer.
  if (output.length !== position.count) return undefined
  if (!Number.isInteger(position.index) || position.index < 0 || position.index >= output.length) return undefined

  return output[position.index]
}
