/**
 * Daily per-user pattern inference (spec §3). Deterministic mining over the
 * user's ledger + optional intent clustering over their assistant prompts.
 * Dismissal suppression: a candidate matching a dismissed pattern's slug, or
 * embedding-similar (>= MEMORY_SIMILARITY_THRESHOLD) to a dismissed summary,
 * is dropped before it can be written. Never throws.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { embedTexts, embeddingsConfigured, cosineSimilarity } from '@/lib/rag/embeddings'
import { MEMORY_SIMILARITY_THRESHOLD } from '@/lib/memory/agent-memory'
import { Prisma } from '@prisma/client'
import { mineUserPatternCandidates, mineIntentClusters, type PatternCandidate } from './mine-patterns'
import { mineToolCorrelations, mineCapabilityGaps } from './mine-correlations'
import { minePeerPractices, groupProvidersByExecution, type PeerPracticeInputs } from './mine-peer-practices'
import { mineArchetypeGaps, type ArchetypeInputs } from './mine-archetypes'
import { writeUserInference } from './user-insights'

const WINDOW_DAYS = 90
const MAX_EVENTS = 500
const MIN_EVENTS = 10

export type InferOverrides = {
  db?: typeof systemPrisma
  embed?: (texts: string[]) => Promise<number[][]>
  now?: () => Date
  /** Catalog tool names per provider; defaults to loading the org's tool planes. */
  loadCapabilities?: (organizationId: string, userId: string) => Promise<Map<string, string[]>>
  /** Peer-practice inputs; defaults to loading org-shared flows + their runs. */
  loadPeerInputs?: (organizationId: string, userId: string, now: Date) => Promise<PeerPracticeInputs | null>
  /** Archetype inputs; defaults to loading k-anon platform rows + org shapes. */
  loadArchetypeInputs?: (organizationId: string, now: Date) => Promise<ArchetypeInputs | null>
}

/**
 * Archetype-gap inputs (platform-archetypes spec): the k-anonymous platform
 * rows (the table only ever holds rows at/above the floor) plus this org's
 * own shapes and touched providers. Returns null on any failure.
 */
async function loadPlatformArchetypeInputs(
  db: typeof systemPrisma,
  organizationId: string,
  now: Date,
): Promise<ArchetypeInputs | null> {
  try {
    const { computeShapesForOrg } = await import('@/lib/intelligence/aggregate-archetypes')
    const [archetypes, org] = await Promise.all([
      db.platformArchetype.findMany({
        orderBy: { orgCount: 'desc' },
        take: 100,
        select: { signature: true, providers: true, triggerType: true, orgCount: true },
      }),
      computeShapesForOrg(organizationId, now, db),
    ])
    if (archetypes.length === 0) return null
    return {
      archetypes: archetypes.map((row) => ({
        signature: row.signature,
        providers: Array.isArray(row.providers) ? (row.providers as string[]) : [],
        triggerType: row.triggerType,
        orgCount: row.orgCount,
      })),
      orgShapeSignatures: new Set(org.shapes.keys()),
      orgProviders: org.orgProviders,
      now,
    }
  } catch {
    return null
  }
}

const PEER_RUN_WINDOW_DAYS = 30

/**
 * Peer-practice inputs (peer-practices spec): org-SHARED flows owned by
 * others, their succeeded-run counts, and the runtime providers those runs
 * touched — resolved from the org's tool_call ledger via executionId, so the
 * provider vocabulary matches the user's own events exactly. Privacy: only
 * `visibility != 'private'` flows are ever loaded; owner identity goes no
 * further than the `userId != user` filter. Returns null on any failure.
 * db is systemPrisma in the cron path — the org-wide event scan is by design.
 */
async function loadPeerPracticeInputs(
  db: typeof systemPrisma,
  organizationId: string,
  userId: string,
  now: Date,
): Promise<PeerPracticeInputs | null> {
  try {
    const [peerFlows, ownFlows] = await Promise.all([
      db.flow.findMany({
        where: {
          organizationId,
          visibility: { not: 'private' },
          NOT: { userId },
          OR: [{ status: 'ACTIVE' }, { NOT: { publishedGraph: { equals: Prisma.DbNull } } }],
        },
        select: { id: true, name: true },
        take: 50,
      }),
      db.flow.findMany({ where: { organizationId, userId }, select: { id: true }, take: 50 }),
    ])
    if (peerFlows.length === 0) return { peerFlows: [], ownFlowProviders: [], now }

    const allFlowIds = [...peerFlows.map((f) => f.id), ...ownFlows.map((f) => f.id)]
    const runSince = new Date(now.getTime() - PEER_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const [runs, toolEvents] = await Promise.all([
      db.flowRun.findMany({
        where: { organizationId, flowId: { in: allFlowIds }, status: 'succeeded', startedAt: { gte: runSince } },
        select: { id: true, flowId: true, startedAt: true },
        orderBy: { startedAt: 'asc' },
        take: 2000,
      }),
      db.userEvent.findMany({
        where: { organizationId, kind: 'tool_call', occurredAt: { gte: runSince } },
        select: { resourceId: true, context: true },
        take: 4000,
      }),
    ])
    const providersByExecution = groupProvidersByExecution(toolEvents)

    const byFlow = new Map<string, { providers: Set<string>; runs: number; firstRunAt: Date }>()
    for (const run of runs) {
      const acc = byFlow.get(run.flowId) ?? { providers: new Set<string>(), runs: 0, firstRunAt: run.startedAt }
      acc.runs += 1
      for (const provider of providersByExecution.get(run.id) ?? []) acc.providers.add(provider)
      byFlow.set(run.flowId, acc)
    }
    const ownFlowIds = new Set(ownFlows.map((f) => f.id))
    return {
      peerFlows: peerFlows.map((flow) => {
        const acc = byFlow.get(flow.id)
        return {
          id: flow.id,
          name: flow.name,
          providers: [...(acc?.providers ?? [])].sort(),
          successfulRuns: acc?.runs ?? 0,
          firstRunAt: acc?.firstRunAt ?? now,
        }
      }),
      ownFlowProviders: [...byFlow.entries()]
        .filter(([flowId]) => ownFlowIds.has(flowId))
        .map(([, acc]) => [...acc.providers].sort()),
      now,
    }
  } catch {
    return null
  }
}

/**
 * Catalog tool names per runtime provider for the gap miner. Loads the same
 * planes the agent runtime and flow catalog use. Best-effort: any plane (or
 * the whole load) failing degrades to an empty map — gap rule 3 simply finds
 * nothing that day. Dynamic import keeps the tool planes (and their MCP/Nango
 * dependency surface) out of the behavior module load path.
 */
export async function loadCapabilityCatalog(organizationId: string, userId: string): Promise<Map<string, string[]>> {
  try {
    const planes = await import('@/features/agents/tool-planes')
    const [mcp, native, nango] = await Promise.all([
      planes.loadMcpConnectionPlaneGroups(organizationId, userId).catch(() => []),
      planes.loadNativePlaneGroups(organizationId).catch(() => []),
      planes.loadNangoPlaneGroups(organizationId, userId).catch(() => []),
    ])
    const byProvider = new Map<string, string[]>()
    for (const group of [...mcp, ...native, ...nango]) {
      if (!group.tools.length) continue
      byProvider.set(group.provider, [...(byProvider.get(group.provider) ?? []), ...group.tools.map((t) => t.name)])
    }
    return byProvider
  } catch {
    return new Map()
  }
}

export async function inferUserBehaviorPatterns(
  organizationId: string,
  userId: string,
  overrides: InferOverrides = {},
): Promise<{ patterns: number } | { skipped: string }> {
  // systemPrisma: cron-only job; the userId_slug upsert has no org key in its
  // unique where (queries themselves stay org+user scoped).
  const db = overrides.db ?? systemPrisma
  try {
    const now = overrides.now ? overrides.now() : new Date()
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const events = await db.userEvent.findMany({
      where: { organizationId, userId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EVENTS,
    })
    if (events.length < MIN_EVENTS) return { skipped: 'too-few-events' }

    let candidates: PatternCandidate[] = mineUserPatternCandidates(events)

    // Cross-tool correlation + capability gaps (cross-tool spec §3). Gap
    // inputs load best-effort: a failed catalog or flow lookup shrinks the
    // gap surface for the day, never fails inference.
    candidates = [...candidates, ...mineToolCorrelations(events)]
    const manualFlowIds = new Set(
      events.filter((e) => e.kind === 'flow_run_manual' && e.resourceType === 'flow' && e.resourceId).map((e) => e.resourceId as string),
    )
    const manualTriggerFlowIds = new Set<string>()
    if (manualFlowIds.size > 0) {
      const flows = await db.flow
        .findMany({ where: { id: { in: [...manualFlowIds] }, organizationId }, select: { id: true, trigger: true } })
        .catch(() => [])
      for (const flow of flows) {
        const trigger = flow.trigger as { type?: string } | null
        if (!trigger?.type || trigger.type === 'manual') manualTriggerFlowIds.add(flow.id)
      }
    }
    const loadCapabilities = overrides.loadCapabilities ?? loadCapabilityCatalog
    const capabilitiesByProvider = await loadCapabilities(organizationId, userId)
    candidates = [...candidates, ...mineCapabilityGaps(events, { capabilitiesByProvider, manualTriggerFlowIds, now })]

    // Org-level peer practices (peer-practices spec): org-shared automations
    // teammates run over tools this user touches. Best-effort — a failed load
    // means no peer candidates today, never a failed inference.
    const loadPeerInputs = overrides.loadPeerInputs ?? ((org: string, user: string, at: Date) => loadPeerPracticeInputs(db, org, user, at))
    const peerInputs = await loadPeerInputs(organizationId, userId, now)
    if (peerInputs) candidates = [...candidates, ...minePeerPractices(events, peerInputs)]

    // Platform archetypes (phase 3): what many OTHER orgs automate over this
    // org's tool mix. Rows are k-anonymous by construction; best-effort load.
    const loadArchetypes = overrides.loadArchetypeInputs ?? ((org: string, at: Date) => loadPlatformArchetypeInputs(db, org, at))
    const archetypeInputs = await loadArchetypes(organizationId, now)
    if (archetypeInputs) candidates = [...candidates, ...mineArchetypeGaps(events, archetypeInputs)]

    // Intent clustering over assistant prompts (needs message text by reference).
    const embed = overrides.embed ?? (embeddingsConfigured() ? (texts: string[]) => embedTexts(texts, { inputType: 'document' }) : null)
    if (embed) {
      const promptEvents = events.filter((e) => e.kind === 'assistant_prompt' && e.resourceId)
      if (promptEvents.length >= 3) {
        const messages = await db.assistantChatMessage.findMany({
          where: { id: { in: promptEvents.map((e) => e.resourceId as string) } },
          select: { id: true, content: true },
        })
        const textById = new Map(messages.map((m) => [m.id, m.content]))
        const prompts = promptEvents
          .map((e) => ({ eventId: e.id, text: textById.get(e.resourceId as string) ?? '', occurredAt: e.occurredAt }))
          .filter((p) => p.text.trim().length > 0)
        candidates = [...candidates, ...(await mineIntentClusters(prompts, embed))]
      }
    }
    if (candidates.length === 0) return { skipped: 'no-candidates' }

    // Dismissal suppression: exact slug + embedding similarity to dismissed summaries.
    const dismissed = await db.userPattern.findMany({
      where: { organizationId, userId, status: 'dismissed' },
      select: { slug: true, summary: true },
    })
    const dismissedSlugs = new Set(dismissed.map((d) => d.slug))
    candidates = candidates.filter((c) => !dismissedSlugs.has(c.slug))
    if (embed && dismissed.length > 0 && candidates.length > 0) {
      const vectors = await embed([...dismissed.map((d) => d.summary), ...candidates.map((c) => c.summary)])
      const dismissedVecs = vectors.slice(0, dismissed.length)
      candidates = candidates.filter((_, i) => {
        const vec = vectors[dismissed.length + i]
        if (!vec || vec.length === 0) return true
        return !dismissedVecs.some((dv) => dv.length > 0 && cosineSimilarity(dv, vec) >= MEMORY_SIMILARITY_THRESHOLD)
      })
    }

    let written = 0
    // A recurring routine re-opens an EXPIRED row (it's a routine again) but
    // never a DISMISSED one — dismissal is the user's decision, not decay.
    await db.userPattern.updateMany({
      where: { organizationId, userId, status: 'expired', slug: { in: candidates.map((c) => c.slug) } },
      data: { status: 'open' },
    })
    for (const candidate of candidates) {
      await db.userPattern.upsert({
        where: { userId_slug: { userId, slug: candidate.slug } },
        create: {
          organizationId, userId, slug: candidate.slug, kind: candidate.kind,
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
        // Recompute stats from the sliding window; status is preserved so a
        // dismissed row (raced past the filter) can never be resurrected.
        update: {
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
      })
      const ok = await writeUserInference({
        organizationId, userId, slug: candidate.slug,
        text: candidate.summary, evidenceEventIds: candidate.evidenceEventIds,
      })
      if (ok) written += 1
    }
    return { patterns: written }
  } catch (error) {
    apiLogger.warn('behavior.inferUserBehaviorPatterns failed', {
      organizationId, userId, error: error instanceof Error ? error.message : String(error),
    })
    // Background jobs must surface, not vanish: a broken inference loop means
    // the platform silently stops learning.
    captureError(error, { scope: 'behavior.infer', organizationId })
    return { skipped: 'error' }
  }
}
