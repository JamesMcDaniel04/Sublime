/**
 * Deterministic cross-tool correlation + capability-gap miner (cross-tool spec
 * §3). Same contract as mine-patterns.ts: pure functions over the ascending
 * ledger, computed counts, evidence event ids — no LLM, ever.
 *
 * Correlation counts only sessions anchored by at least one INTERACTIVE
 * (non-tool_call) event: a scheduled flow touching two providers at 3am is
 * already automated — suggesting a bridge for it would be noise.
 *
 * Gap semantics: firstSeenAt is when the gap's cause was observed;
 * lastSeenAt is `now` — a gap is observed at mining time, which is what keeps
 * it from tripping the staleness gate while it still holds.
 */
import type { LedgerEvent, PatternCandidate } from './mine-patterns'

export const SESSION_GAP_MS = 30 * 60 * 1000
export const MIN_CORRELATION_SESSIONS = 5
export const MIN_CORRELATION_DAYS = 3
export const DORMANT_CONNECTION_DAYS = 30
/** Cap unused-capability gaps per provider so wide catalogs can't flood. */
export const MAX_UNUSED_CAPABILITY_GAPS = 3

const DAY_MS = 24 * 60 * 60 * 1000
const dateOf = (d: Date) => d.toISOString().slice(0, 10)

const providerOf = (e: LedgerEvent): string | null =>
  e.kind === 'tool_call' && e.resourceId ? e.resourceId : null

const contextField = (e: LedgerEvent, field: string): unknown => {
  const ctx = e.context
  return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx as Record<string, unknown>)[field] : undefined
}

/** Split an ascending event stream into sessions on inactivity gaps. */
export function sessionize(events: LedgerEvent[]): LedgerEvent[][] {
  const sessions: LedgerEvent[][] = []
  let current: LedgerEvent[] = []
  for (const event of events) {
    const last = current[current.length - 1]
    if (last && event.occurredAt.getTime() - last.occurredAt.getTime() > SESSION_GAP_MS) {
      sessions.push(current)
      current = []
    }
    current.push(event)
  }
  if (current.length) sessions.push(current)
  return sessions
}

/**
 * Provider pairs co-occurring in interactive sessions. A qualifying session
 * has >=1 non-tool_call event and tool_call events on >=2 distinct providers.
 * Threshold: >= MIN_CORRELATION_SESSIONS sessions across >= MIN_CORRELATION_DAYS
 * distinct dates.
 */
export function mineToolCorrelations(events: LedgerEvent[]): PatternCandidate[] {
  type Acc = { sessions: number; dates: Set<string>; first: Date; last: Date; evidence: string[] }
  const pairs = new Map<string, Acc>()

  for (const session of sessionize(events)) {
    if (!session.some((e) => e.kind !== 'tool_call')) continue
    const byProvider = new Map<string, LedgerEvent[]>()
    for (const e of session) {
      const provider = providerOf(e)
      if (!provider) continue
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), e])
    }
    const providers = [...byProvider.keys()].sort()
    if (providers.length < 2) continue
    const start = session[0].occurredAt
    const end = session[session.length - 1].occurredAt
    for (let i = 0; i < providers.length; i++) {
      for (let j = i + 1; j < providers.length; j++) {
        const key = `${providers[i]}+${providers[j]}`
        const evidence = [...(byProvider.get(providers[i]) ?? []), ...(byProvider.get(providers[j]) ?? [])].map((e) => e.id)
        const acc = pairs.get(key)
        if (acc) {
          acc.sessions += 1
          acc.dates.add(dateOf(start))
          acc.first = start < acc.first ? start : acc.first
          acc.last = end > acc.last ? end : acc.last
          acc.evidence.push(...evidence)
        } else {
          pairs.set(key, { sessions: 1, dates: new Set([dateOf(start)]), first: start, last: end, evidence })
        }
      }
    }
  }

  return [...pairs.entries()]
    .filter(([, acc]) => acc.sessions >= MIN_CORRELATION_SESSIONS && acc.dates.size >= MIN_CORRELATION_DAYS)
    .map(([key, acc]) => {
      const [a, b] = key.split('+')
      return {
        slug: `toolcorr:${key}`,
        kind: 'tool_correlation' as const,
        summary: `Uses ${a} and ${b} together in the same work sessions — ${acc.sessions} sessions across ${acc.dates.size} days`,
        occurrenceCount: acc.sessions,
        firstSeenAt: acc.first,
        lastSeenAt: acc.last,
        evidenceEventIds: [...new Set(acc.evidence)],
      }
    })
}

export interface GapInputs {
  /** Catalog tool names per provider (from the flow tool catalog). */
  capabilitiesByProvider: Map<string, string[]>
  /** Flows whose trigger is manual (the schedule trigger exists, unused). */
  manualTriggerFlowIds: Set<string>
  now: Date
}

/**
 * Three deterministic gap rules (spec §3): dormant connection, manual cadence,
 * unused bridging capability. Every gap cites ledger evidence — a connection
 * older than the mining window (whose connection_added event aged out) is
 * skipped rather than asserted without evidence.
 */
export function mineCapabilityGaps(events: LedgerEvent[], inputs: GapInputs): PatternCandidate[] {
  const gaps: PatternCandidate[] = []
  const now = inputs.now

  const calledByProvider = new Map<string, Set<string>>()
  for (const e of events) {
    const provider = providerOf(e)
    if (!provider) continue
    const names = contextField(e, 'toolNames')
    const set = calledByProvider.get(provider) ?? new Set<string>()
    if (Array.isArray(names)) for (const name of names) if (typeof name === 'string') set.add(name)
    calledByProvider.set(provider, set)
  }

  // Rule 1 — dormant connection: added >= DORMANT_CONNECTION_DAYS ago, zero
  // tool_call events for that provider ever (within the mining window).
  for (const e of events) {
    if (e.kind !== 'connection_added') continue
    const provider = contextField(e, 'provider')
    if (typeof provider !== 'string' || !provider) continue
    if (now.getTime() - e.occurredAt.getTime() < DORMANT_CONNECTION_DAYS * DAY_MS) continue
    if (calledByProvider.has(provider)) continue
    gaps.push({
      slug: `gap:dormant:${provider}`,
      kind: 'capability_gap',
      summary: `Connected ${provider} on ${dateOf(e.occurredAt)} but no agent or flow has used it since`,
      occurrenceCount: 1,
      firstSeenAt: e.occurredAt,
      lastSeenAt: now,
      evidenceEventIds: [e.id],
    })
  }

  // Rule 2 — manual cadence: >= 3 manual runs of a manual-trigger flow on the
  // same UTC weekday across distinct dates (mirrors the temporal miner's
  // routine definition; recomputed here so this miner stays self-contained).
  const routineRuns = new Map<string, { dates: Set<string>; first: Date; last: Date; evidence: string[] }>()
  for (const e of events) {
    if (e.kind !== 'flow_run_manual' || e.resourceType !== 'flow' || !e.resourceId) continue
    if (!inputs.manualTriggerFlowIds.has(e.resourceId)) continue
    const key = `${e.resourceId}:${e.occurredAt.getUTCDay()}`
    const acc = routineRuns.get(key) ?? { dates: new Set<string>(), first: e.occurredAt, last: e.occurredAt, evidence: [] }
    if (!acc.dates.has(dateOf(e.occurredAt))) {
      acc.dates.add(dateOf(e.occurredAt))
      acc.evidence.push(e.id)
      acc.first = e.occurredAt < acc.first ? e.occurredAt : acc.first
      acc.last = e.occurredAt > acc.last ? e.occurredAt : acc.last
    }
    routineRuns.set(key, acc)
  }
  for (const [key, acc] of routineRuns) {
    if (acc.dates.size < 3) continue
    const flowId = key.slice(0, key.lastIndexOf(':'))
    gaps.push({
      slug: `gap:schedule:${flowId}`,
      kind: 'capability_gap',
      summary: `Runs a manual-trigger flow by hand on a weekly cadence (${acc.dates.size} times) — a schedule trigger could run it automatically`,
      occurrenceCount: acc.dates.size,
      firstSeenAt: acc.first,
      lastSeenAt: now,
      evidenceEventIds: acc.evidence,
    })
  }

  // Rule 3 — unused bridging capability: a provider inside a qualifying
  // tool_correlation whose catalog lists capabilities never called by this
  // user. Capped per provider; alphabetical so the pick is deterministic.
  const correlations = mineToolCorrelations(events)
  const correlatedProviders = new Set(correlations.flatMap((c) => c.slug.replace('toolcorr:', '').split('+')))
  for (const provider of [...correlatedProviders].sort()) {
    const catalog = inputs.capabilitiesByProvider.get(provider)
    if (!catalog?.length) continue
    const called = calledByProvider.get(provider) ?? new Set<string>()
    const unused = catalog.filter((name) => !called.has(name)).sort().slice(0, MAX_UNUSED_CAPABILITY_GAPS)
    const evidence = [...new Set(events.filter((e) => providerOf(e) === provider).map((e) => e.id))]
    const firstUse = events.find((e) => providerOf(e) === provider)
    for (const toolName of unused) {
      gaps.push({
        slug: `gap:capability:${provider}:${toolName}`,
        kind: 'capability_gap',
        summary: `Works with ${provider} regularly but never uses its "${toolName}" capability`,
        occurrenceCount: evidence.length,
        firstSeenAt: firstUse?.occurredAt ?? now,
        lastSeenAt: now,
        evidenceEventIds: evidence,
      })
    }
  }

  return gaps
}
