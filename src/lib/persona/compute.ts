/**
 * Org persona: debounced recompute from accumulated signals (connections,
 * scan profiles, activity ledger). The Postgres row is the source of truth
 * and is always written; a graph projection mirrors it when RAG is
 * configured — logged LOUDLY either way, because production has graph
 * credentials and a silent no-op there is a defect, not a config choice.
 * Never throws — safe to fire-and-forget from scan/backfill hooks.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { commitGraph } from '@/lib/rag/indexer'
import { ragEnabled } from '@/lib/rag/get-store'
import { canonicalIntegrationSlug, type Department } from '@/lib/templates/departments'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import {
  computeDepartmentWeights,
  hasNarrativeSignal,
  personaGraphNode,
  type PersonaSignals,
} from './weights'

/** Recompute cooldown; read per call so tests can override. Default 1h. */
function cooldownMs(): number {
  const parsed = Number(process.env.PERSONA_RECOMPUTE_COOLDOWN_MS)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000
}

const NARRATIVE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    narrative: { type: 'string', description: '2-4 sentence description of how this organization works and what it automates.' },
    confidence: { type: 'number', description: '0..1 confidence that the narrative reflects real usage rather than guesswork.' },
  },
  required: ['narrative', 'confidence'],
}

async function gatherSignals(organizationId: string): Promise<PersonaSignals> {
  const [nango, mcp, activityBySource] = await Promise.all([
    prisma.nangoConnection.findMany({ where: { organizationId, status: 'connected' }, select: { providerConfigKey: true } }),
    prisma.mcpConnection.findMany({ where: { organizationId, isActive: true }, select: { name: true } }),
    prisma.activityEvent.groupBy({ by: ['source'], where: { organizationId }, _count: { _all: true } }),
  ])
  const connectedToolSlugs = [
    ...nango.map((row) => canonicalIntegrationSlug(row.providerConfigKey)),
    ...mcp.map((row) => canonicalIntegrationSlug(row.name)),
  ]
  // Scan profiles persist as 'learning' memories under the hidden org-intelligence
  // agent, keyed by sourceRef `<plane>:<connectionRef>` — the connectionRef slice
  // canonicalizes to the tool slug ('nango:github' → 'github').
  const agentId = await findOrgIntelligenceAgentId(organizationId)
  const scannedConnectionSlugs: string[] = []
  if (agentId) {
    const memories = await prisma.agentMemory.findMany({
      where: { organizationId, agentId, kind: 'learning' },
      select: { sourceRef: true },
      distinct: ['sourceRef'],
    })
    for (const memory of memories) {
      const ref = memory.sourceRef?.split(':')[1]
      if (ref) scannedConnectionSlugs.push(canonicalIntegrationSlug(ref))
    }
  }
  const activityEventCounts = Object.fromEntries(
    activityBySource.map((row: { source: string; _count: { _all: number } }) => [canonicalIntegrationSlug(row.source), row._count._all]),
  )
  return { connectedToolSlugs, scannedConnectionSlugs, activityEventCounts }
}

async function generateNarrative(
  organizationId: string,
  signals: PersonaSignals,
  weights: Record<Department, number>,
  generate: typeof generateStructured,
): Promise<{ narrative: string; confidence: number } | null> {
  const agentId = await findOrgIntelligenceAgentId(organizationId)
  const memories = agentId
    ? await prisma.agentMemory.findMany({
        where: { organizationId, agentId, kind: 'learning', status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { title: true },
      })
    : []
  const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
  const raw = await generate({
    schemaName: 'org_persona_narrative',
    schema: NARRATIVE_JSON_SCHEMA,
    maxTokens: 400,
    model,
    system:
      'You are profiling an organization from its connected-tool usage so an automation platform can calibrate suggestions and agent behavior. Write a 2-4 sentence persona narrative: what kind of team this appears to be, which departments dominate, and what they appear to automate or care about. Describe patterns and shapes only — never quote names, emails, or any record contents. Also return a 0..1 confidence.',
    user: [
      `Connected tools: ${[...new Set(signals.connectedToolSlugs)].join(', ') || 'none'}`,
      `Department weights: ${JSON.stringify(weights)}`,
      `Activity volume by source: ${JSON.stringify(signals.activityEventCounts)}`,
      'Usage learnings:',
      ...(memories.length ? memories.map((m) => `- ${m.title}`) : ['- none']),
    ].join('\n'),
  })
  try {
    const parsed = JSON.parse(raw) as { narrative?: unknown; confidence?: unknown }
    if (typeof parsed.narrative !== 'string' || !parsed.narrative.trim()) return null
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
    return { narrative: parsed.narrative.trim().slice(0, 2000), confidence }
  } catch {
    return null
  }
}

function summarizeSignals(signals: PersonaSignals): Prisma.InputJsonValue {
  return {
    connectedTools: [...new Set(signals.connectedToolSlugs)],
    scannedConnections: [...new Set(signals.scannedConnectionSlugs)],
    activityEventCounts: signals.activityEventCounts,
  }
}

export async function recomputeOrgPersona(
  organizationId: string,
  opts: { force?: boolean } = {},
  deps: { generate?: typeof generateStructured; now?: () => Date } = {},
): Promise<{ status: 'computed' | 'skipped-cooldown' | 'failed' }> {
  const generate = deps.generate ?? generateStructured
  const now = deps.now?.() ?? new Date()
  try {
    const existing = await prisma.organizationPersona.findUnique({
      where: { organizationId },
      select: { computedAt: true },
    })
    if (!opts.force && existing && now.getTime() - existing.computedAt.getTime() < cooldownMs()) {
      return { status: 'skipped-cooldown' }
    }

    const signals = await gatherSignals(organizationId)
    const weights = computeDepartmentWeights(signals)

    let narrative: string | null = null
    let confidence: number | null = null
    if (hasNarrativeSignal(signals)) {
      try {
        const generated = await generateNarrative(organizationId, signals, weights, generate)
        if (generated) ({ narrative, confidence } = generated)
      } catch (error) {
        apiLogger.warn('persona: narrative generation failed — keeping deterministic weights', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const weightsJson = weights as unknown as Prisma.InputJsonValue
    await prisma.organizationPersona.upsert({
      where: { organizationId },
      create: {
        organizationId,
        departmentWeights: weightsJson,
        narrative,
        confidence,
        signalsSummary: summarizeSignals(signals),
        computedAt: now,
      },
      // On update, only touch narrative/confidence when this pass produced
      // one — a failed or gated narrative pass must never null a stored one.
      update: {
        departmentWeights: weightsJson,
        ...(narrative !== null ? { narrative, confidence } : {}),
        signalsSummary: summarizeSignals(signals),
        computedAt: now,
      },
    })

    if (ragEnabled()) {
      try {
        await commitGraph(organizationId, [personaGraphNode(organizationId, weights, narrative)], [])
        apiLogger.info('persona: projected to knowledge graph', { organizationId })
      } catch (error) {
        // error (not warn) by design: production HAS graph credentials, so a
        // projection failure is a real defect, never an unconfigured env.
        apiLogger.error('persona: graph projection failed', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      apiLogger.info('persona: graph projection skipped — NEO4J_*/VOYAGE_API_KEY not configured', { organizationId })
    }

    return { status: 'computed' }
  } catch (error) {
    apiLogger.warn('persona: recompute failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: 'failed' }
  }
}
