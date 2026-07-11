# Architecture

## Runtime Boundary

There are two runtimes:

1. **Next.js**: pages, authentication, CRUD APIs, integration management, execution inspection, and external trigger endpoints.
2. **Worker**: one Fastify process with BullMQ consumers for manual, scheduled, webhook-triggered, and resumed agent runs.

Both runtimes report errors through `src/lib/observability/sentry.ts`; the worker initializes it at boot (tagged `process: worker`) and flushes on shutdown.

Pipedream owns embedded account connections; Klavis owns agent-facing MCP tool servers. Model access goes through `src/lib/llm/model-runner.ts`, which routes `claude-*` models to the Anthropic SDK and everything else to OpenAI, and falls back to whichever provider's key is configured so a run never hard-fails on a missing vendor. Defaults are OpenAI: the agent model is `AGENT_MODEL` (default `gpt-4o`) and cheap surfaces (run Q&A, activity headlines, the natural-language agent builder) use `SUMMARY_MODEL` (default `gpt-4o-mini`). Set a `claude-*` model plus `ANTHROPIC_API_KEY` to use Anthropic.

## Agent Execution

1. Runs are enqueued by `POST /api/agents/:id/execute` (manual), the BullMQ job schedulers reconciled in `agent-schedule-registrar.ts` (hourly/daily/weekly/cron), or `POST /api/agents/:id/trigger` (webhook, authenticated by a per-agent secret).
2. The worker loads the agent and its active Klavis MCP connections, then runs a model tool-calling loop (max `AGENT_MAX_TURNS`, default 16). Each tool call is persisted as a `WorkflowStep` and `WorkflowEvent`; token usage accumulates on the execution.
3. The loop always exposes an `ask_user` tool. When the model calls it, the run pauses: the provider-native transcript is persisted on the execution, status becomes `waiting_for_input`, and the question is stored as an `ExecutionMessage`.
4. `POST /api/executions/:id/reply` records the user's answer and enqueues a resume job; the worker replays the saved transcript, feeds the answer back as the tool result, and continues.
5. Output or failure is persisted on the execution and surfaced by Agent HQ. `POST /api/chat` answers follow-up questions about a finished run; `GET /api/usage` reports month-to-date token usage per organization.

`POST /api/agents/draft` turns a plain-language description into an agent configuration (structured output) and can create the agent directly.

## Flow Execution

Flows execute inline in the calling process today (`runFlowExecution` in `src/features/flows/execute-flow.ts`) via the same routes agents use for triggering (manual execute, webhook trigger, cron dispatch, reply, approval decision). A resume (a reply or approval decision reaching a paused run) atomically claims the run — only a `waiting` run may be resumed — and pins execution to the exact graph the run started with (`FlowRun.graphSnapshot`), never the flow's current definition. A `flow-execution` BullMQ queue and worker exist (`dispatchFlowExecution`/`executeFlowJob`) but are not yet wired into any caller — flows still run inline everywhere in practice.

## Shared Server Utilities

- `src/lib/prisma.ts`: process-wide Prisma client
- `src/lib/server/auth.ts`: required Supabase user and tenant context
- `src/lib/server/api-handler.ts`: authenticated API wrapper and consistent errors
- `src/lib/supabase/middleware.ts`: session refresh and page protection

All tenant data queries must include `organizationId` — enforced at runtime by a tenant guard on the shared Prisma client (`src/lib/tenant-guard.ts`): org-carrying models refuse reads/updates/deletes whose `where` lacks `organizationId`. Enumerated system-wide paths (cron sweeps, reapers, tenant resolution, worker-internal id-keyed writes) use the unguarded `systemPrisma` export, each with a justification comment. The only session-less API route is the agent trigger endpoint, which authenticates with a per-agent secret.

People.ai webhook deliveries are verified per-tenant: each organization has its own signing secret (`Organization.peopleAiWebhookSecret`, encrypted at rest), minted at connect time and rotatable by an org admin (`/api/peopleai/webhook-secret`); an org with a secret never accepts the global fallback secret.

## Core Data

`prisma/schema.prisma` intentionally contains only organizations, users, agents, executions, execution messages, workflow steps/events, templates, integrations, and Klavis MCP connections. Executions carry the resumable model transcript, token counts, and the model that ran them.

Organization deletion is complete: every org-owned model cascades via FK (WS-R4 closed the gaps — flows, custom signals, push subscriptions, knowledge, shared skills), and `teardownOrganization` (`src/lib/org-teardown.ts`) deprovisions external Klavis/Nango resources and clears the org's Neo4j nodes before deleting the row. The daily retention cron prunes `run:`/`signal:` graph nodes in lockstep with the Postgres rows it deletes.

Knowledge and agent-memory retrieval rank in-database with pgvector: each carries an `embeddingVec vector(1024)` column with an HNSW cosine index, and retrieval is a `<=>` distance query over all of an org's rows (no in-memory scan / 500-row cap). Reads/writes go through raw SQL wrapped in `SET LOCAL search_path = public, extensions` so the `vector` type resolves on Supabase. The legacy `embedding Json` columns are still written for deploy-window safety and are slated to drop (see follow-ups).

## Testing

Most logic is unit-tested with `node:test` (`npm test`). API routes are additionally smoke-tested end to end: `src/app/api/__tests__/route-smoke.test.ts` invokes each `withAuthenticatedApi`-wrapped GET handler (all but three that require an external service, which are explicitly skipped) against a seeded test DB — via a production-inert auth seam in `src/lib/server/auth.ts` (`setTestAuthContext`, gated on `NODE_ENV !== 'production' && TEST_DATABASE_URL`) — and fails on any 5xx. A completeness self-check enumerates the route tree and fails if a `withAuthenticatedApi` GET route is added without a case or a documented skip, so the net can't silently rot. This is the regression net for unscoped-query / tenant-guard failures (the class that caused a production incident on 2026-07-10). It runs in CI, where `TEST_DATABASE_URL` is set against the pgvector Postgres image. (Session-auth GET routes that read `getAuthWithUser()` directly — `peopleai/*` — are outside the seam's reach and not covered; see the WS-R6 plan.)

## Known follow-ups (tracked tech debt)

- **Drop legacy embedding Json columns.** WS-R5 moved knowledge/memory retrieval to pgvector (`embeddingVec`); the `KnowledgeChunk.embedding` / `AgentMemory.embedding` Json columns are now write-only legacy, kept so the previous deployment's instances keep working during a rollout. Drop both in the next schema migration once no code reads them.
- **Re-embed NULL-vector rows after enabling embeddings.** The vector retrieval path excludes `embeddingVec IS NULL` rows, and the keyword fallback only runs when the query itself can't embed — so knowledge/memories ingested while `VOYAGE_API_KEY` was unset (or skipped by the dimension-guarded backfill) are searched by neither path once embeddings are configured. Add a re-embed pass over `embeddingVec IS NULL` rows (or a documented "re-index after enabling embeddings" step); there is no auto-reindex today.
- **Flow-editor reducer (WS-R6 Phase 2, deferred).** `src/app/flows/[id]/page.tsx` is a 1,186-line god-component with 26 `useState` hooks and manual undo/redo. It should carve into a typed reducer + context, but that refactor needs a React component-test harness first (none exists — all tests are `.test.ts` logic tests) so it's regression-covered; see `docs/superpowers/plans/2026-07-10-remediation-ws6-route-smoke-harness.md`.
- **MCP transport consolidation.** There are three near-duplicate MCP clients — `klavis-client.ts`, `mcp-client.ts`, and `sublime-mcp.ts` — each reimplementing JSON-RPC, SSE parsing, session handling, and the initialize handshake. They should collapse into one transport with pluggable auth (none / api-key / oauth2-client-credentials / oauth2-authcode / static-bearer). The `MCPAgent` (Klavis, per-user) vs `McpConnection` (custom, per-org) model split is the same divide surfacing in the schema.
- **Per-org credentials for built-in tools.** Slack, Granola, and Email are keyed to single global env vars, so every organization shares one account — acceptable single-tenant, blocking for multi-tenant. The per-user `Integration` table already exists and should hold these.
- **Tool-discovery caching.** `loadTools` runs `initialize` + `tools/list` against every server on every run (drops past the per-server 20 / global 64 caps are now logged). Cache the discovered tool lists (the Klavis path already persists them for the capability cards) and run discovery in parallel.
- **Frontend data layer.** Pages fetch with raw `fetch` + `useState` + `setInterval`; shared domain types now live in `src/lib/types.ts`, but a query cache (e.g. TanStack Query) would remove the hand-rolled polling, refetch-everything mutations, and the `AGENTS_CHANGED_EVENT` window-event bus.
