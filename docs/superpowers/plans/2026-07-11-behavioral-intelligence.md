# Behavioral Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Learn how each org operates from connected tools (auto-scan on connect), synthesize org-specific workflow suggestions as draft flows, and auto-distill successful runs into reusable templates — committing everything to shared memory + the graph so each request starts warmer.

**Architecture:** Three additive modules under `src/lib/intelligence/` reusing existing primitives — tool planes (read-only sampling), Neo4j `insight` nodes (indexer), deduped shared agent memory, the copilot graph generator, and run reflection. One small migration (`Organization.settings Json`, `Flow.metadata Json`). All learning is visible (activity events + notifications), org-scoped, and read-only against external tools.

**Tech Stack:** TypeScript, Prisma, existing LLM runner (`generateStructured`, cheap tier), Neo4j/Voyage via existing rag modules, `node:test`.

**Decisions locked (2026-07-11):** auto-scan on connect (org toggle + Rescan action, distilled-profile-only persistence); auto-create draft templates (tagged, deduped, capped 20/org, oldest evicted).

## Global Constraints

- **UX narrative (user-provided reference):** the experience presents as three stages — **01 Connect your tools** ("learning happens automatically — no migrations"), **02 Your data takes shape** (scan/profile progress visible on the Integrations page), **03 Your AI goes live** (suggested flows + auto-templates ready to deploy). Copy on new UI should echo this framing.

- Scanner NEVER calls a tool whose name matches write verbs: `/(create|send|post|update|delete|write|add|remove|set|execute|run|insert|upload|patch|move|archive)/i`; allowlist `/(list|get|search|recent|fetch|read|find|history|describe)/i`; ≤ **6 tools** per scan, one call each, empty/minimal args, 15s timeout, response truncated to 8k chars.
- Only distilled profile text persists — never raw sampled records.
- Every learning action emits an activity event or notification (no silent learning).
- LLM passes use the cheap model tier (same as `reflection.ts`).
- Suggestions/templates always land as DRAFTS a human activates; nothing auto-publishes.
- Each task ends green: `npm run typecheck && npm test`, commit per task.

---

### Task 1: Foundations — migration + settings toggle + scan module core

**Files:**
- Create migration: `prisma/migrations/<ts>_org_settings_flow_metadata/migration.sql` — `ALTER TABLE organizations ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'; ALTER TABLE flows ADD COLUMN metadata JSONB;` + schema.prisma fields (`settings Json @default("{}")` on Organization, `metadata Json?` on Flow).
- Create: `src/lib/intelligence/connection-scan.ts`
- Create: `src/lib/intelligence/__tests__/connection-scan.test.ts` (pure parts)

**Interfaces (produces):**
```ts
// connection-scan.ts
export function selectScanTools(tools: { name: string; description: string }[], max?: number): string[] // pure, tested
export type UsageProfile = { summary: string; entities: string[]; processes: string[]; automationCandidates: string[] }
export async function scanConnection(params: {
  organizationId: string
  userId: string | null
  plane: 'klavis' | 'nango' | 'mcp'
  connectionRef: string   // MCPAgent id | nango capability/provider | McpConnection id
  connectionName: string
}): Promise<{ scanned: boolean; processes: number } | { skipped: string }>
export function scanEnabled(orgSettings: unknown): boolean // settings.disableConnectionScans !== true
```

**Steps:**
- [ ] TDD `selectScanTools`: write-verb names excluded even when they also match the allowlist; allowlist-ranked; cap respected; empty input → [].
- [ ] TDD `scanEnabled`: default true; `{disableConnectionScans:true}` → false.
- [ ] Implement `scanConnection`: guard `scanEnabled` (load org.settings) → load the plane's groups via existing loaders (klavis: `loadKlavisPlaneGroups` filtered to ref; nango: `loadNangoPlaneGroups`; mcp: `loadMcpConnectionPlaneGroups` with `connectionIds:[ref]`) → `selectScanTools` → call each via `group.client.executeTool` with `{}` args wrapped in `AbortSignal.timeout(15000)`+try/catch → build sample pack (truncate 8k/tool) → `generateStructured` (schema = UsageProfile) → persist:
  - graph: new `indexConnectionScan({organizationId, connectionRef, connectionName, profile})` in `src/lib/rag/indexer.ts` → `insight` node id `insight:scan:<plane>:<connectionRef>` (org-shared) — full-replace on rescan by stable id.
  - memory: one `saveAgentMemory({kind:'learning', title:'How we use <name>: <process>' , content: process, agentId: ORG_WIDE?})` — **note:** memory is agent-scoped; use a reserved org-wide agent id convention `agentId: 'org'`? NO — check `retrieveAgentMemory` filters by agentId. Decision: save under a synthetic `agentId = 'org:shared'` AND extend `retrieveAgentMemory` to also query `agentId: 'org:shared'` rows (one-line `IN` filter). Verify FK: agent_memories.agentId is a plain String column (no FK per WS map) — confirm before relying.
  - `notify({type:'intelligence.scan', title:'Scanned <name> — learned N processes', link:'/integrations'})`.
- [ ] Verify + commit.

### Task 2: Scan triggers on connect (all three planes)

**Files:** Modify: the Klavis instance-create route (`src/app/api/mcp/connections/route.ts` POST or `server-provisioning.ts` — locate `prisma.mCPAgent.create`), the Nango connection-persist route (locate `nangoConnection.create`/upsert), the MCP OAuth callback success path (`api/mcp-connections/oauth/callback/route.ts`) AND the api-key/none connection create (`api/mcp-connections/route.ts` POST).

**Steps:**
- [ ] After each successful create/authorize, fire-and-forget the scan without blocking the response. Serverless caveat: plain `void` promises can be killed at response end on Vercel — use `after(() => scanConnection(...))` from `next/server` (Next 15) at each route; confirm availability (`grep '"next"' package.json`) and fall back to `void` + comment if <15.
- [ ] Add a `POST /api/intelligence/rescan` route (body: plane+ref) for the manual Rescan action; register in route-smoke skips (POST-only).
- [ ] Settings UI: on the /settings page (exists from the parallel session) add the "Connection scanning" toggle writing `organizations.settings.disableConnectionScans` via the existing org PATCH.
- [ ] Integrations page: a slim "Your data takes shape" status strip — recent `intelligence.scan` notifications rendered as learning progress (e.g. "Learning from GitHub — 3 processes understood"), echoing stage 02 of the UX narrative.
- [ ] Verify + commit.

### Task 3: Workflow suggestions (Phase 2)

**Files:** Create `src/lib/intelligence/suggest-workflows.ts` + test; modify `src/app/api/cron/dispatch/route.ts` (weekly tick) and `connection-scan.ts` (post-scan hook); UI rail on `src/app/flows/page.tsx`.

**Steps:**
- [ ] `synthesizeWorkflowSuggestions(organizationId)`: gather the org's scan insights (graph search seeded by `insight:scan:*` — or direct prisma read of memories `agentId:'org:shared'`) + last 20 run headlines → `generateStructured` → `{suggestions: [{title, description, flowPrompt}]}` (≤3 per pass).
- [ ] For each: `saveAgentMemory({kind:'suggestion', agentId:'org:shared'})` — its embedding dedupe (≥0.86) stops re-suggesting accepted/dismissed ideas. If saved fresh (not deduped): generate a draft flow via the copilot generation path (reuse the server-side generator the `/api/flows/copilot` route uses — extract if inline) → `prisma.flow.create({status:'DRAFT', name:title, description, metadata:{suggested:true, sourceMemoryId}})`.
- [ ] Trigger: end of every successful `scanConnection` + weekly in the cron dispatch tick (guard: ≤1 synthesis/org/day via a settings timestamp).
- [ ] `/flows` page: "Your AI is ready" / "Suggested for you" section (stage 03 of the UX narrative) listing flows with `metadata.suggested` — open (normal builder) or dismiss (delete flow + mark memory dismissed).
- [ ] Verify + commit.

### Task 4: Template-from-run (Phase 3)

**Files:** Modify `src/features/agents/reflection.ts` (+ its test), create `src/lib/intelligence/template-from-run.ts` + test; templates page badge.

**Steps:**
- [ ] Extend reflection's structured schema with `replayable: { worthTemplating: boolean, title?: string, description?: string, exampleInput?: string }` (prompt: "would a reasonable operator want to run this same job again with different inputs?").
- [ ] `maybeCreateTemplateFromRun({execution, agent, replayable})`: skip unless worthTemplating && run succeeded && ≥1 tool used. Dedupe: embed `title+description`, cosine ≥0.86 vs existing auto-generated templates' embeddings (store embedding in template configuration). Create `agentTemplate` row: `type: agent's category or 'Auto-generated'`, `configuration: { instructions: agent.objective, integrations: agent's connector keys, autoGenerated: true, sourceExecutionId, embedding }`. Cap: 20 auto-generated per org — evict oldest (deleteMany oldest beyond cap).
- [ ] Call from `reflectAndRemember`'s completion path (post-run, best-effort).
- [ ] **Org-scoped catalogue priority (user requirement 2026-07-11):**
  - Auto-generated templates are PRIVATE to the creating org: exclude `configuration.autoGenerated` rows from the cross-org community listing in `GET /api/agent-templates` (they encode org-specific process intel — today that GET lists every org's rows as a shared library, which would leak them).
  - Ordering: the org's OWN catalogue first (auto-generated + own-created), then the shared global community repository — both in the GET's response order and visually sectioned on /templates ("Your library" above "Community").
- [ ] `/templates`: badge "From your runs" for `configuration.autoGenerated` and show delete on them.
- [ ] Verify + commit.

### Task 5: Ship + prove the loop

- [ ] Full gate: typecheck, lint, full tests (incl. DB-gated), build; push main; confirm Vercel READY.
- [ ] Live proof: connect a Klavis tool (or run `/api/intelligence/rescan` on an existing connection) → confirm the notification, the `insight:scan:*` node in Neo4j, `org:shared` memories, and (after synthesis) a suggested draft flow appears on /flows.
- [ ] Update the memory files (behavioral-intelligence status; deploy topology unchanged).

## Risks

- **Empty-args tool calls may error on required params** — expected: errors are caught per-tool; the profile works with whatever sampled successfully (≥1 success required to persist a profile).
- ~~synthetic agentId~~ **VERIFIED: `agent_memories.agentId` has an FK → AgentTask (cascade).** Design: Task 1 creates one hidden org-wide AgentTask per org (`type:'system'`, `status:'SYSTEM'`, title 'Organization intelligence', excluded from agent lists by status filter) — `orgIntelligenceAgentId(organizationId)` helper get-or-creates it; all scan learnings/suggestions attach there; `retrieveAgentMemory` gains `includeAgentIds` so every agent's runs also retrieve org-wide memories.
- **VERIFIED: Next 15.5 — use `after()` from `next/server`** for post-response scan work.
- **Suggestion quality** cold-start: with only 1 agent and no runs, synthesis may produce generic ideas — the ≤3 cap + dedupe keeps noise bounded.
