/**
 * Behavioral-intelligence connection scan.
 *
 * When an org connects (or re-verifies) a tool, this module runs a bounded,
 * READ-ONLY sample of its usage and distills that sample into a durable
 * "usage profile" — never the raw sampled records — which is persisted to
 * both the knowledge graph (an org-shared insight node) and the org-wide
 * agent memory (so every agent's context can draw on it).
 *
 * Safety invariants (do not relax without updating the plan):
 *   - Never calls a tool whose name/description matches a write verb, even if
 *     it also matches the read allowlist.
 *   - At most MAX_SCAN_TOOLS tools per scan, one call each, empty args.
 *   - Each call is bounded by SCAN_TOOL_TIMEOUT_MS and truncated to
 *     MAX_SAMPLE_CHARS before ever reaching the LLM.
 *   - Only the distilled profile text is stored — raw tool output is
 *     discarded after the LLM pass.
 */

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { recordTokenUsage } from '@/lib/usage/budget'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { notify } from '@/lib/notifications/service'
import { indexConnectionScan, indexToolCatalog, removeConnectionScanFromGraph } from '@/lib/rag/indexer'
import { formatFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { loadMcpConnectionPlaneGroups, loadNangoPlaneGroups, type ToolPlaneGroup } from '@/features/agents/tool-planes'
import { connectionSourceRef, isScanExcluded, type ScanPlane } from './scan-exclusions'
import { knowledgeCaptureSettings } from '@/lib/knowledge/settings'

// Re-exported so existing server-side importers of connection-scan.ts (this
// module owns the domain) keep working unchanged — the implementations live
// in scan-exclusions.ts (a zero-import module) so client components can pull
// them in without dragging prisma/server code into the browser bundle.
export { SCAN_PLANES, connectionSourceRef, isValidScanExclusionEntry, isScanExcluded } from './scan-exclusions'
export type { ScanPlane } from './scan-exclusions'

export const MAX_SCAN_TOOLS = 6
export const SCAN_TOOL_TIMEOUT_MS = 15_000
export const MAX_SAMPLE_CHARS = 8_000

// Never call anything matching a write verb — checked FIRST, and wins even
// when a tool also matches the read allowlist below (e.g. "archive_and_list").
const WRITE_VERB_RE = /(create|send|post|update|delete|write|add|remove|set|execute|run|insert|upload|patch|move|archive)/i
// Only tools that look like read/listing operations are eligible to sample.
const READ_ALLOWLIST_RE = /(list|get|search|recent|fetch|read|find|history|describe)/i

/**
 * Pure: pick up to `max` read-only tool names to sample, in the order
 * offered. A tool is eligible only if neither its name nor description
 * matches a write verb, AND its name or description matches the read
 * allowlist. Write-verb exclusion always wins over an allowlist match.
 */
export function selectScanTools(tools: { name: string; description: string }[], max = MAX_SCAN_TOOLS): string[] {
  const selected: string[] = []
  for (const tool of tools) {
    if (selected.length >= max) break
    const isWrite = WRITE_VERB_RE.test(tool.name) || WRITE_VERB_RE.test(tool.description ?? '')
    if (isWrite) continue
    const isReadable = READ_ALLOWLIST_RE.test(tool.name) || READ_ALLOWLIST_RE.test(tool.description ?? '')
    if (!isReadable) continue
    selected.push(tool.name)
  }
  return selected
}

/** Pure: org settings gate — default on, off only when explicitly disabled. */
export function scanEnabled(orgSettings: unknown): boolean {
  if (orgSettings && typeof orgSettings === 'object' && !Array.isArray(orgSettings)) {
    return (orgSettings as Record<string, unknown>).disableConnectionScans !== true
  }
  return true
}

/** A Nango connection is "connected" for scan-triggering purposes. */
export const NANGO_CONNECTED_STATUS = 'connected'

/**
 * Pure: decide whether a Nango-mirrored connection should trigger a usage
 * scan on this poll, keyed off the STATUS TRANSITION rather than mere
 * presence of a prior mirror row. A row that was first mirrored in an
 * error/pending state and later becomes connected must still scan — so
 * "genuinely new" means either no prior row at all, or a prior row whose
 * status wasn't connected while this poll reports it connected. A
 * connection that was already connected on the previous poll (and still is)
 * never re-triggers, and a connection that isn't connected on this poll
 * never triggers regardless of history.
 */
export function shouldScanNangoConnection(previous: { status: string } | undefined, nowConnected: boolean): boolean {
  if (!nowConnected) return false
  if (!previous) return true
  return previous.status !== NANGO_CONNECTED_STATUS
}

export type UsageProfile = {
  summary: string
  entities: string[]
  processes: string[]
  automationCandidates: string[]
}

const usageProfileSchema = z.object({
  summary: z.string().default(''),
  entities: z.array(z.string()).default([]),
  processes: z.array(z.string()).default([]),
  automationCandidates: z.array(z.string()).default([]),
})

const USAGE_PROFILE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    entities: { type: 'array', items: { type: 'string' } },
    processes: { type: 'array', items: { type: 'string' } },
    automationCandidates: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'entities', 'processes', 'automationCandidates'],
}

/** Tolerant parse: strip fences, find the object, validate. Null on garbage. */
function parseUsageProfile(raw: string): UsageProfile | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = usageProfileSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      /* try next */
    }
  }
  return null
}

function buildScanPrompt(connectionName: string, samples: { tool: string; result: string }[]): { system: string; user: string } {
  return {
    system:
      'You are the read-only usage-scanner for a connected business tool. Given a small sample of read-only tool call outputs, produce a distilled usage profile: a one-paragraph summary of how this org uses the tool, the concrete entity types present (e.g. customers, tickets, deals, channels), the discrete business processes the data evidences, and up to 5 automation candidates (repeatable actions this usage pattern suggests could be automated). Be concrete and terse. Never quote raw record contents, names, emails, or other PII verbatim — describe patterns and shapes only.',
    user: [
      `Connection: ${connectionName}`,
      'Sampled read-only tool outputs (truncated):',
      ...samples.map((s) => `### ${s.tool}\n${s.result}`),
    ].join('\n\n'),
  }
}

/** Race a promise against a timeout without relying on callee abort support. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(ms)
    const onAbort = () => reject(new Error(`scan tool call timed out after ${ms}ms`))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function truncateSample(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return text.length > MAX_SAMPLE_CHARS ? text.slice(0, MAX_SAMPLE_CHARS) : text
}

/**
 * Get-or-create the single hidden AgentTask that holds org-wide learnings
 * from connection scans. Uses `status: 'SYSTEM'` (not 'ACTIVE') so it never
 * shows up in any ACTIVE-status agent listing, and `agentType: 'SYSTEM'`
 * makes it unambiguously not a user-facing agent.
 * `visibility: 'private'` with no `userId` means `agentReadScope`
 * (src/lib/server/visibility.ts) hides it from every user-facing listing
 * that applies that scope — no real user ever matches its (absent) owner.
 * Memories saved under this agent's id are org-wide, shared learnings — not
 * scoped to any single agent's own run history.
 *
 * A partial unique index on `agent_tasks (organizationId) WHERE agentType =
 * 'SYSTEM'` (see prisma/migrations/20260711130000_org_settings_flow_metadata)
 * prevents two concurrent first-scans for the same org from creating two
 * holder rows; on that race, the losing `create` throws Prisma P2002 and we
 * re-read the winner's row instead.
 */
/**
 * Read-only lookup — does NOT create the holder. For call sites that must
 * not conjure the hidden agent into existence just by looking (the learnings
 * view, disconnect purge): an org that never scanned anything has no holder,
 * and should read as "no learnings" / "nothing to purge", not get one created.
 */
export async function findOrgIntelligenceAgentId(organizationId: string): Promise<string | null> {
  const existing = await prisma.agentTask.findFirst({
    where: { organizationId, agentType: 'SYSTEM' },
    select: { id: true },
  })
  return existing?.id ?? null
}

export async function orgIntelligenceAgentId(organizationId: string): Promise<string> {
  const existing = await findOrgIntelligenceAgentId(organizationId)
  if (existing) return existing
  try {
    const created = await prisma.agentTask.create({
      data: {
        organizationId,
        agentType: 'SYSTEM',
        status: 'SYSTEM',
        visibility: 'private',
        userId: null,
        description: 'Organization intelligence',
        objective: 'Holds org-wide learnings from connection scans',
      },
      select: { id: true },
    })
    return created.id
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
    if (!isUniqueViolation) throw error
    const winner = await prisma.agentTask.findFirst({
      where: { organizationId, agentType: 'SYSTEM' },
      select: { id: true },
    })
    if (winner) return winner.id
    throw error
  }
}

/**
 * Postgres cannot use the tool-sampling path below (its useful read tool needs
 * SQL, and the generic sampler calls tools with empty args), so it supplies its
 * own authored sampler. Returns the same `{ tool, result }` shape the rest of
 * the pipeline consumes, plus the tool catalog to index.
 */
async function collectPostgresScan(
  organizationId: string,
  connectionRef: string,
): Promise<{ samples: { tool: string; result: string }[]; tools: { name: string; description: string }[] }> {
  const { collectPostgresSamples } = await import('@/lib/postgres/scan')
  const { postgresTools } = await import('@/lib/postgres/tools')
  const raw = await withTimeout(collectPostgresSamples(organizationId, connectionRef), SCAN_TOOL_TIMEOUT_MS)
  return {
    samples: raw.map((sample) => ({ tool: sample.tool, result: truncateSample(sample.result) })),
    // The catalog indexes the READ surface only: whether this database also
    // permits writes is a per-connection setting, not a property of the plane.
    tools: postgresTools(false).map((tool) => ({ name: tool.name, description: tool.description })),
  }
}

async function loadScanGroup(
  organizationId: string,
  userId: string | null,
  plane: 'nango' | 'mcp',
  connectionRef: string,
): Promise<ToolPlaneGroup | undefined> {
  const groups =
    plane === 'nango'
      ? await loadNangoPlaneGroups(organizationId, userId)
      : await loadMcpConnectionPlaneGroups(organizationId, userId, { connectionIds: [connectionRef] })
  const wantId = formatFlowToolConnectionId(plane, connectionRef)
  return groups.find((g) => g.id === wantId)
}

/**
 * Run one bounded, read-only usage scan of a connection and distill it into
 * a persisted usage profile (graph node + org-wide agent memories). Never
 * throws — degrades to `{ skipped: reason }` on any failure or gate.
 */
export async function scanConnection(params: {
  organizationId: string
  userId: string | null
  plane: ScanPlane
  connectionRef: string
  connectionName: string
}): Promise<{ scanned: boolean; processes: number } | { skipped: string }> {
  const { organizationId, userId, plane, connectionRef, connectionName } = params
  try {
    const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } })
    if (!scanEnabled(org?.settings)) return { skipped: 'disabled' }
    const sourceRef = connectionSourceRef(plane, connectionRef)
    if (isScanExcluded(org?.settings, sourceRef)) return { skipped: 'excluded' }

    const samples: { tool: string; result: string }[] = []

    if (plane === 'postgres') {
      let scan: Awaited<ReturnType<typeof collectPostgresScan>>
      try {
        scan = await collectPostgresScan(organizationId, connectionRef)
      } catch (error) {
        apiLogger.warn('connectionScan: postgres sampling failed', {
          organizationId, plane, connectionRef,
          error: error instanceof Error ? error.message : String(error),
        })
        return { skipped: 'sample-failed' }
      }
      if (scan.samples.length === 0) return { skipped: 'no-samples' }
      void indexToolCatalog(organizationId, [{ provider: 'postgres', name: connectionName, tools: scan.tools }]).catch(() => undefined)
      samples.push(...scan.samples)
    } else {
      const group = await loadScanGroup(organizationId, userId, plane, connectionRef)
      if (!group?.client || group.tools.length === 0) return { skipped: 'no-tools' }

      // Materialize this connection's tool topology as org-shared tool +
      // capability nodes (cross-tool spec §4) — runs on connect AND rescan so
      // the graph tracks the live catalog. Fire-and-forget: never blocks the scan.
      void indexToolCatalog(organizationId, [{
        provider: group.provider,
        name: connectionName,
        tools: group.tools.map((tool) => ({ name: tool.name, description: tool.description })),
      }]).catch(() => undefined)

      const toolNames = selectScanTools(group.tools)
      if (toolNames.length === 0) return { skipped: 'no-safe-tools' }

      for (const name of toolNames) {
        try {
          const result = await withTimeout(group.client.executeTool(group.serverUrl, name, {}), SCAN_TOOL_TIMEOUT_MS)
          samples.push({ tool: name, result: truncateSample(result) })
        } catch (error) {
          apiLogger.warn('connectionScan: tool call failed, skipping', {
            organizationId, plane, connectionRef, tool: name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (samples.length === 0) return { skipped: 'no-samples' }
    }

    const { system, user } = buildScanPrompt(connectionName, samples)
    // Distillation is a background, non-user-facing pass — run it on the
    // cheap model tier, same convention as reflectAndRemember.
    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generateStructured({ system, user, schema: USAGE_PROFILE_JSON_SCHEMA, schemaName: 'connection_usage_profile', maxTokens: 1200, model })
    // Rough metering (~chars/4) since generateStructured returns no token
    // usage — here rather than the route so cron-driven scans meter too.
    void recordTokenUsage(organizationId, Math.ceil((system.length + user.length + (raw?.length ?? 0)) / 4)).catch(() => undefined)
    const profile = parseUsageProfile(raw)
    if (!profile) return { skipped: 'no-profile' }

    await indexConnectionScan({ organizationId, plane, connectionRef, connectionName, profile })

    await import('@/lib/knowledge/capture')
      .then(({ captureConnectionProfileKnowledge }) => captureConnectionProfileKnowledge({
        organizationId,
        userId,
        plane,
        connectionRef,
        connectionName,
        profile,
      }))
      .catch((error) => {
        apiLogger.warn('connectionScan: knowledge capture failed', {
          organizationId,
          plane,
          connectionRef,
          error: error instanceof Error ? error.message : String(error),
        })
      })

    const agentId = await orgIntelligenceAgentId(organizationId)
    for (const process of profile.processes.slice(0, 5)) {
      await saveAgentMemory({
        organizationId,
        agentId,
        kind: 'learning',
        title: `How we use ${connectionName}: ${process.slice(0, 80)}`,
        content: process,
        sourceRef,
      })
    }

    // title/body split so the Integrations page learning-progress strip can
    // render "Learning from <name> — <body>" without re-parsing the title.
    await notify({
      organizationId,
      userId: userId ?? undefined,
      type: 'intelligence.scan',
      title: connectionName,
      body: [
        `${profile.processes.length} process${profile.processes.length === 1 ? '' : 'es'} understood`,
        ...profile.processes.slice(0, 5).map((process) => `• ${process}`),
      ].join('\n'),
      link: '/integrations',
    })

    // Persona refresh: this scan may be the org's first real usage signal.
    // Dynamic import — compute.ts imports findOrgIntelligenceAgentId from
    // THIS module, so a static import back would be a cycle. Debounced
    // internally, so repeated scans are cheap no-ops.
    void import('@/lib/persona/compute')
      .then((mod) => mod.recomputeOrgPersona(organizationId))
      .catch(() => undefined)

    // Fire-and-forget: a fresh profile may be the one that tips the org over
    // the >=3-connection suggestion gate, or add new cross-tool signal to an
    // org already past it. Dynamically imported to avoid a static import
    // cycle (suggest-workflows imports orgIntelligenceAgentId from this
    // module); guarded internally to <=1 synthesis/org/day, so this never
    // does meaningful work on most scans.
    void import('@/lib/intelligence/suggest-workflows')
      .then((mod) => mod.synthesizeWorkflowSuggestions(organizationId))
      .catch((error) => {
        apiLogger.warn('connectionScan: post-scan suggestion synthesis failed', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      })

    return { scanned: true, processes: profile.processes.length }
  } catch (error) {
    apiLogger.warn('scanConnection failed', {
      organizationId, plane, connectionRef,
      error: error instanceof Error ? error.message : String(error),
    })
    return { skipped: 'error' }
  }
}

/**
 * Purge-on-disconnect (Task 4.5): when a connection is deleted, hard-delete
 * the org-intelligence agent's memories it produced and remove its scan
 * insight node from the graph, so stale learnings from a tool the org no
 * longer has access to can't keep surfacing. Unlike the learnings view's
 * soft dismiss, this is a hard delete — the connection itself is gone, so
 * there's nothing left to dedupe a future re-scan against.
 *
 * Best-effort + logged, mirroring org-teardown's per-resource pattern: each
 * leg is isolated so a failure in one never blocks (or throws into) the
 * caller's disconnect flow. An org that never scanned this connection (no
 * holder agent, or no matching memories) is a silent no-op.
 *
 * Honors the org's `retainKnowledgeOnDisconnect` setting (default true):
 * retained business context is the product's core value, so learned memories
 * and graph insight survive a disconnect unless the org opted out. When the
 * settings read fails we retain — losing learnings is the irreversible
 * outcome, so the purge is the leg that must prove it's authorized.
 */
export async function purgeConnectionLearnings(params: {
  organizationId: string
  plane: ScanPlane
  connectionRef: string
}): Promise<void> {
  const { organizationId, plane, connectionRef } = params
  const sourceRef = connectionSourceRef(plane, connectionRef)

  try {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    })
    if (knowledgeCaptureSettings(organization?.settings).retainOnDisconnect) {
      apiLogger.info('purgeConnectionLearnings: retained (retainKnowledgeOnDisconnect)', {
        organizationId, plane, connectionRef,
      })
      return
    }
  } catch (error) {
    apiLogger.warn('purgeConnectionLearnings: settings read failed, retaining learnings', {
      organizationId, plane, connectionRef,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  try {
    const agentId = await findOrgIntelligenceAgentId(organizationId)
    if (agentId) {
      await prisma.agentMemory.deleteMany({ where: { organizationId, agentId, sourceRef } })
    }
  } catch (error) {
    apiLogger.warn('purgeConnectionLearnings: memory purge failed', {
      organizationId, plane, connectionRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    await removeConnectionScanFromGraph({ organizationId, plane, connectionRef })
  } catch (error) {
    apiLogger.warn('purgeConnectionLearnings: graph purge failed', {
      organizationId, plane, connectionRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
