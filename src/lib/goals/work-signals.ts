/**
 * Turns settled work into targeting rule candidates. Pure, deterministic, no
 * LLM — a rule the team can read, argue with, and later disprove.
 *
 * The algorithm is a ONE-SPLIT DECISION STUMP, chosen because it is exactly
 * the shape of the statement we want to produce. "Deals under 14 days cold"
 * is actionable; a correlation coefficient is not.
 *
 * Only settled human decisions count as evidence. `pending` means nobody
 * looked yet, and treating silence as rejection would teach the agent to stop
 * producing work simply because the queue is backed up.
 */
import type { Disposition } from '@/lib/goals/work-transitions'

export const MIN_RULE_SAMPLE = 5
export const MIN_SKIP_RATE = 0.7

export type WorkObservation = {
  disposition: Disposition
  skipReason: string | null
  signals: Record<string, unknown> | null
}

export type RuleCandidate = {
  signal: string
  statement: string
  /** Skipped rows inside the band the statement describes. */
  skippedCount: number
  /** All rows inside that band. */
  totalCount: number
  topSkipReason: string | null
}

type Settled = { skipped: boolean; skipReason: string | null; value: number | string }

const isSettled = (disposition: Disposition) =>
  disposition === 'skipped' || disposition === 'used' || disposition === 'edited'

/** Only values a statement can describe. */
function usableValue(raw: unknown): number | string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw
  return null
}

function topReason(rows: Settled[]): string | null {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.skipped || !row.skipReason) continue
    counts.set(row.skipReason, (counts.get(row.skipReason) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  // Sorted for determinism: an arbitrary tie-break would make the same input
  // produce different statements between runs.
  for (const [reason, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = reason
      bestCount = count
    }
  }
  return best
}

/**
 * The floor is on SKIPS, not band size. The skips are the evidence for "don't
 * do this"; a band of 5 that is 4 skips and 1 use rests on four observations
 * however wide you draw it.
 */
function qualifies(band: Settled[]): boolean {
  const skipped = band.filter((row) => row.skipped).length
  if (skipped < MIN_RULE_SAMPLE) return false
  return skipped / band.length >= MIN_SKIP_RATE
}

/** Purity first, then evidence. Ranking by size alone prefers a sloppy wide
 *  band that swallows used rows over the clean split that actually explains
 *  the skips. */
function beats(candidate: RuleCandidate, best: RuleCandidate | null): boolean {
  if (!best) return true
  const purity = candidate.skippedCount / candidate.totalCount
  const bestPurity = best.skippedCount / best.totalCount
  if (purity !== bestPurity) return purity > bestPurity
  return candidate.totalCount > best.totalCount
}

function candidateFrom(signal: string, band: Settled[], statement: string): RuleCandidate {
  return {
    signal,
    statement,
    skippedCount: band.filter((row) => row.skipped).length,
    totalCount: band.length,
    topSkipReason: topReason(band),
  }
}

/** Numeric: try every midpoint, keep the qualifying split with the most evidence. */
function numericCandidate(signal: string, rows: Settled[]): RuleCandidate | null {
  const values = [...new Set(rows.map((row) => row.value as number))].sort((a, b) => a - b)
  let best: RuleCandidate | null = null

  for (let index = 0; index < values.length - 1; index += 1) {
    const split = (values[index] + values[index + 1]) / 2
    const bands = [
      ['under', rows.filter((row) => (row.value as number) < split)],
      ['over', rows.filter((row) => (row.value as number) >= split)],
    ] as const

    for (const [side, band] of bands) {
      if (!qualifies(band)) continue
      const statement =
        side === 'under'
          ? `Do not work subjects whose ${signal} is under ${split}.`
          : `Do not work subjects whose ${signal} is ${split} or more.`
      const candidate = candidateFrom(signal, band, statement)
      if (beats(candidate, best)) best = candidate
    }
  }
  return best
}

/** Categorical: each distinct value is its own band. */
function categoricalCandidate(signal: string, rows: Settled[]): RuleCandidate | null {
  let best: RuleCandidate | null = null
  const values = [...new Set(rows.map((row) => row.value as string))].sort()

  for (const value of values) {
    const band = rows.filter((row) => row.value === value)
    if (!qualifies(band)) continue
    const candidate = candidateFrom(signal, band, `Do not work subjects whose ${signal} is "${value}".`)
    if (beats(candidate, best)) best = candidate
  }
  return best
}

export function findRuleCandidates(rows: WorkObservation[]): RuleCandidate[] {
  const bySignal = new Map<string, Settled[]>()

  for (const row of rows) {
    if (!isSettled(row.disposition) || !row.signals) continue
    for (const [key, raw] of Object.entries(row.signals)) {
      const value = usableValue(raw)
      if (value === null) continue
      const bucket = bySignal.get(key) ?? []
      bucket.push({ skipped: row.disposition === 'skipped', skipReason: row.skipReason, value })
      bySignal.set(key, bucket)
    }
  }

  const candidates: RuleCandidate[] = []
  for (const [signal, values] of [...bySignal.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (values.length < MIN_RULE_SAMPLE) continue
    // A signal arriving as both a number and a string is drifting; skip it
    // rather than comparing across types.
    const allNumeric = values.every((row) => typeof row.value === 'number')
    const allString = values.every((row) => typeof row.value === 'string')
    if (!allNumeric && !allString) continue

    const candidate = allNumeric
      ? numericCandidate(signal, values)
      : categoricalCandidate(signal, values)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}
