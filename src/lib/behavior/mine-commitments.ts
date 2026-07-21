/**
 * Commitment miner (notes intelligence). Deterministic, pure: groups the
 * user's distilled `made_commitment` rows (derived from Granola meeting
 * notes by knowledge/notes-distill.ts) by (meeting series, action). A series
 * where the user keeps committing to the same follow-through is the
 * strongest automate-this signal notes can offer.
 *
 * Kind 'commitment' gates as a NORMAL evidence-backed pattern — the standard
 * MIN_OCCURRENCES / MIN_SPAN_DAYS / learning-period rules apply unchanged in
 * eligibility.ts. Slug prefix `commit:` (registered in outcome-weights) lets
 * the outcome-learning layer throttle the kind if its suggestions keep
 * getting rejected.
 */
import { MIN_OCCURRENCES } from './eligibility'
import type { PatternCandidate } from './mine-patterns'

export type CommitmentRow = {
  /** ActivityEvent id — the evidence ref. */
  id: string
  series: string
  action: string
  occurredAt: Date
}

const MAX_CANDIDATES = 5

const compactSlug = (value: string) => value.replace(/\s+/g, '-')

export function mineCommitments(rows: CommitmentRow[]): PatternCandidate[] {
  // Series and action both contain spaces, so a joined key can't be split
  // back apart — carry both through the group value instead.
  const groups = new Map<string, { series: string; action: string; rows: CommitmentRow[] }>()
  for (const row of rows) {
    if (!row.series || !row.action) continue
    const key = `${compactSlug(row.series)}::${compactSlug(row.action)}`
    const group = groups.get(key) ?? { series: row.series, action: row.action, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const candidates: PatternCandidate[] = []
  for (const { series, action, rows: group } of groups.values()) {
    if (group.length < MIN_OCCURRENCES) continue
    const sorted = [...group].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    candidates.push({
      slug: `commit:${compactSlug(series)}:${compactSlug(action)}`,
      kind: 'commitment',
      summary: `In ${group.length} recent "${series}" meetings you committed to ${action} — the follow-through could run itself`,
      occurrenceCount: group.length,
      firstSeenAt: sorted[0].occurredAt,
      lastSeenAt: sorted[sorted.length - 1].occurredAt,
      evidenceEventIds: sorted.map((row) => row.id),
    })
  }
  return candidates
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, MAX_CANDIDATES)
}
