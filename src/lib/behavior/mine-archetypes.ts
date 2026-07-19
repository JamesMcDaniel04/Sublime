/**
 * Deterministic platform-archetype gap miner (intelligence phase 3). Pure
 * functions, computed counts, no LLM — the phase 1 miner contract.
 *
 * Inputs arrive pre-anonymized: archetype rows exist only when the k-anon
 * floor was met at aggregation time (see aggregate-archetypes.ts), so this
 * miner never sees — and can never leak — anything about a specific org.
 * Evidence event ids are always the mining user's OWN ledger events.
 */
import type { LedgerEvent, PatternCandidate } from './mine-patterns'

/** At most this many archetype gaps per run — the gate stays quiet. */
export const MAX_ARCHETYPE_CANDIDATES = 3

export interface ArchetypeInput {
  signature: string
  providers: string[]
  triggerType: string
  orgCount: number
}

export interface ArchetypeInputs {
  /** k-anonymous platform rows (orgCount >= floor by construction). */
  archetypes: ArchetypeInput[]
  /** The org's OWN automation-shape signatures — suppresses "already have it". */
  orgShapeSignatures: Set<string>
  /** Runtime providers the org's ledger has touched. */
  orgProviders: Set<string>
  now: Date
}

export function mineArchetypeGaps(events: LedgerEvent[], inputs: ArchetypeInputs): PatternCandidate[] {
  const ownEventsByProvider = new Map<string, LedgerEvent[]>()
  for (const e of events) {
    if (e.kind !== 'tool_call' || !e.resourceId) continue
    ownEventsByProvider.set(e.resourceId, [...(ownEventsByProvider.get(e.resourceId) ?? []), e])
  }

  const candidates: PatternCandidate[] = []
  for (const archetype of inputs.archetypes) {
    if (archetype.providers.length === 0) continue
    // The org must have every tool the archetype spans, and must lack the shape.
    if (!archetype.providers.every((p) => inputs.orgProviders.has(p))) continue
    if (inputs.orgShapeSignatures.has(archetype.signature)) continue
    // Personal relevance + evidence: the user touched at least one provider.
    const ownEvents = archetype.providers.flatMap((p) => ownEventsByProvider.get(p) ?? [])
    if (ownEvents.length === 0) continue
    const firstOwn = ownEvents.reduce((a, b) => (a.occurredAt <= b.occurredAt ? a : b))
    candidates.push({
      slug: `archetype:${archetype.signature}`,
      kind: 'archetype_gap',
      summary: `${archetype.orgCount} other organizations that use ${archetype.providers.join('+')} run ${archetype.triggerType}-triggered automations across them — your workspace has none`,
      occurrenceCount: archetype.orgCount,
      firstSeenAt: firstOwn.occurredAt,
      // Observed at mining time: once the org builds the shape (or the row
      // falls below the k-anon floor and disappears), the pattern stops being
      // re-observed and the staleness gate decays it.
      lastSeenAt: inputs.now,
      evidenceEventIds: [...new Set(ownEvents.map((e) => e.id))],
    })
  }
  return candidates
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, MAX_ARCHETYPE_CANDIDATES)
}
