/**
 * Deterministic org-level peer-practice miner (peer-practices spec). Pure
 * functions, computed counts, no LLM — the phase 1 miner contract.
 *
 * Privacy contract (load-bearing): callers pass only org-SHARED peer flows;
 * candidates name the flow, never its owner; evidence event ids are always
 * the mining user's OWN ledger events. No teammate identity may enter a
 * summary, evidence list, or graph insight through this module.
 */
import type { LedgerEvent, PatternCandidate } from './mine-patterns'

/** A practice is real, not an experiment: >= 3 successful runs in 30 days. */
export const MIN_PEER_RUNS = 3

export interface PeerFlowInput {
  id: string
  name: string
  /** Runtime provider strings the flow's succeeded runs actually touched. */
  providers: string[]
  /** Succeeded runs in the last 30 days. */
  successfulRuns: number
  firstRunAt: Date
}

export interface PeerPracticeInputs {
  peerFlows: PeerFlowInput[]
  /** Provider sets of the user's OWN flows — suppresses "you already have one". */
  ownFlowProviders: string[][]
  now: Date
}

export function minePeerPractices(events: LedgerEvent[], inputs: PeerPracticeInputs): PatternCandidate[] {
  const ownEventsByProvider = new Map<string, string[]>()
  for (const e of events) {
    if (e.kind !== 'tool_call' || !e.resourceId) continue
    ownEventsByProvider.set(e.resourceId, [...(ownEventsByProvider.get(e.resourceId) ?? []), e.id])
  }

  const candidates: PatternCandidate[] = []
  for (const flow of inputs.peerFlows) {
    if (flow.successfulRuns < MIN_PEER_RUNS || flow.providers.length === 0) continue
    const overlap = flow.providers.filter((p) => ownEventsByProvider.has(p))
    if (overlap.length === 0) continue
    // Superset match: one of the user's own flows already spans everything the
    // peer flow touches — the practice is not new to them.
    const covered = inputs.ownFlowProviders.some((own) => flow.providers.every((p) => own.includes(p)))
    if (covered) continue
    candidates.push({
      slug: `peer:flow:${flow.id}`,
      kind: 'peer_practice',
      summary: `Teammates run "${flow.name}" over ${flow.providers.join('+')} — ${flow.successfulRuns} successful runs in the last 30 days; you work with ${overlap.join('+')} but have no similar automation`,
      occurrenceCount: flow.successfulRuns,
      firstSeenAt: flow.firstRunAt,
      // Observed at mining time: once the peer flow stops running (or the
      // user builds their own), the row stops being re-observed and the
      // staleness gate decays it — same mechanism as capability gaps.
      lastSeenAt: inputs.now,
      evidenceEventIds: [...new Set(overlap.flatMap((p) => ownEventsByProvider.get(p) ?? []))],
    })
  }
  return candidates
}

/**
 * Loader helper: group org-wide tool_call ledger rows by the execution they
 * came from (context.executionId), yielding the runtime providers each run
 * touched. Pure so the join logic is testable without a database.
 */
export function groupProvidersByExecution(
  rows: Array<{ resourceId: string | null; context: unknown }>,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.resourceId) continue
    const ctx = row.context
    const executionId =
      ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx as { executionId?: unknown }).executionId : null
    if (typeof executionId !== 'string' || !executionId) continue
    const set = grouped.get(executionId) ?? new Set<string>()
    set.add(row.resourceId)
    grouped.set(executionId, set)
  }
  return grouped
}
