# Architecture

## Runtime Boundary

There are two runtimes:

1. **Next.js**: pages, authentication, CRUD APIs, integration management, execution inspection, and external trigger endpoints.
2. **Worker**: one Fastify process with BullMQ consumers for manual, scheduled, webhook-triggered, and resumed agent runs.

Both runtimes report errors through `src/lib/observability/sentry.ts`; the worker initializes it at boot (tagged `process: worker`) and flushes on shutdown.

Nango owns embedded account connections and deployed integration actions; user-added MCP servers connect through `src/lib/mcp/`. Model access goes through `src/lib/llm/model-runner.ts`: both Claude and Qwen speak the Anthropic Messages wire (Qwen via `QWEN_BASE_URL`), and `routeModel` orders the endpoint chain with a cross-endpoint fallback so a run never hard-fails on a missing vendor. Defaults are Anthropic: the agent model is `AGENT_MODEL` (default `claude-sonnet-5`) and cheap surfaces (run Q&A, activity headlines, the natural-language agent builder) use `SUMMARY_MODEL` (default `claude-haiku-4-5`). Set `QWEN_API_KEY` + `QWEN_BASE_URL` to enable the Qwen endpoint.

## Agent Execution

1. Runs are enqueued by `POST /api/agents/:id/execute` (manual), the BullMQ job schedulers reconciled in `agent-schedule-registrar.ts` (hourly/daily/weekly/cron), or `POST /api/agents/:id/trigger` (webhook, authenticated by a per-agent secret).
2. The worker loads the agent and its active Klavis MCP connections, then runs a model tool-calling loop (max `AGENT_MAX_TURNS`, default 16). Each tool call is persisted as a `WorkflowStep` and `WorkflowEvent`; token usage accumulates on the execution.
3. The loop always exposes an `ask_user` tool. When the model calls it, the run pauses: the provider-native transcript is persisted on the execution, status becomes `waiting_for_input`, and the question is stored as an `ExecutionMessage`.
4. `POST /api/executions/:id/reply` records the user's answer and enqueues a resume job; the worker replays the saved transcript, feeds the answer back as the tool result, and continues.
5. Output or failure is persisted on the execution and surfaced by Agent HQ. `POST /api/chat` answers follow-up questions about a finished run; `GET /api/usage` reports month-to-date token usage per organization.

`POST /api/agents/draft` turns a plain-language description into an agent configuration (structured output) and can create the agent directly.

## Flow Execution

Every flow-execution caller goes through `dispatchFlowExecution` (`src/features/flows/execute-flow.ts`), which branches on `resolveExecutionMode()` (`src/lib/queue/execution-mode.ts`): production defaults to `queue` (enqueue a `flow-execution` BullMQ job, consumed by `executeFlowJob` on the worker), development defaults to `inline` (run `runFlowExecution` in-process so a single `next dev` needs no worker/Redis) — set `EXECUTION_MODE` to override. A resume (a reply or approval decision reaching a paused run) atomically claims the run — only a `waiting` run may be resumed — and pins execution to the exact graph the run started with (`FlowRun.graphSnapshot`), never the flow's current definition. **The manual builder run always executes in the background:** the `/api/flows/[id]/execute` route passes `{ background: true }`, so even in inline mode a fresh run pre-creates its `FlowRun` row and runs detached on the process's event loop (returning `{ queued, flowRunId }` for the panel to poll), instead of being awaited inside — and killed with — the browser request. The builder re-attaches to any still-running run on mount, so navigating away and back never loses an in-flight run.

## Shared Server Utilities

- `src/lib/prisma.ts`: process-wide Prisma client
- `src/lib/server/auth.ts`: required Supabase user and tenant context
- `src/lib/server/api-handler.ts`: authenticated API wrapper and consistent errors
- `src/lib/supabase/middleware.ts`: session refresh and page protection

All tenant data queries must include `organizationId` — enforced at runtime by a tenant guard on the shared Prisma client (`src/lib/tenant-guard.ts`): org-carrying models refuse reads/updates/deletes whose `where` lacks `organizationId`. Enumerated system-wide paths (cron sweeps, reapers, tenant resolution, worker-internal id-keyed writes) use the unguarded `systemPrisma` export, each with a justification comment. The only session-less API route is the agent trigger endpoint, which authenticates with a per-agent secret.

## Core Data

`prisma/schema.prisma` intentionally contains only organizations, users, agents, executions, execution messages, workflow steps/events, templates, integrations, and Klavis MCP connections. Executions carry the resumable model transcript, token counts, and the model that ran them.

Goals are a first-class measurement spine: `Goal` declares the target, `GoalMetric` binds it to a source of truth, `MetricDatapoint` preserves the observed series, and `GoalContribution` attributes agent/flow work without inventing causality. The connector registry in `src/lib/metrics/` reads Stripe, HubSpot, Salesforce, Google Sheets, Postgres (read-only SQL: connection strings are reduced to explicit client config so credential query params can never relax the hardening, and the query runs inside a server-enforced `BEGIN TRANSACTION READ ONLY`), or manual values; `/api/cron/dispatch` refreshes due bindings and evaluates pace. Recommendations are transition-gated: only a change into `at_risk` or `off_track` emits a `goal_action` `UserSuggestion`, preventing repeated cron ticks from spamming the same advice.

Recurring goals advance a sliding window over the same Goal row: settlement writes an immutable `GoalPeriod` and moves `startAt`/`targetDate`/`startValue` in one transaction (capped catch-up, empty windows settle `missed`). Goal context feeds prompts through `goalGroundingBlock` (assistant, agent runs, copilot); a Monday digest (`src/lib/goals/digest.ts`) fans out bell + push + email under an atomic per-user weekly claim. The proof layer's estimated tier is calibrated from human edits only (`GoalContribution.estimateEdited` provenance — provision-time calibrated defaults never feed back into the median), measured AI run time comes from one shared loader (`contributionRunStats`), and `GET /api/goals/report` streams a board-ready PDF whose figures carry the same measured/estimated/correlated labels as the app. `GoalBenchmark` (global, like `PlatformArchetype`) aggregates exact per-kind outcome counts weekly and surfaces only at ≥ 5 distinct orgs.

Organization deletion is complete: every org-owned model cascades via FK (WS-R4 closed the gaps — flows, push subscriptions, knowledge, shared skills), and `teardownOrganization` (`src/lib/org-teardown.ts`) deprovisions external Klavis/Nango resources and clears the org's Neo4j nodes before deleting the row. The daily retention cron prunes `run:`/`signal:` graph nodes in lockstep with the Postgres rows it deletes.

Knowledge and agent-memory retrieval rank in-database with pgvector: each carries an `embeddingVec vector(1024)` column with an HNSW cosine index, and retrieval is a `<=>` distance query over all of an org's rows (no in-memory scan / 500-row cap). Reads/writes go through raw SQL wrapped in `SET LOCAL search_path = public, extensions` so the `vector` type resolves on Supabase. The legacy `embedding Json` columns are still written for deploy-window safety and are slated to drop (see follow-ups).

## Testing

Most logic is unit-tested with `node:test` (`npm test`). API routes are additionally smoke-tested end to end: `src/app/api/__tests__/route-smoke.test.ts` invokes each `withAuthenticatedApi`-wrapped GET handler (all but three that require an external service, which are explicitly skipped) against a seeded test DB — via a production-inert auth seam in `src/lib/server/auth.ts` (`setTestAuthContext`, gated on `NODE_ENV !== 'production' && TEST_DATABASE_URL`) — and fails on any 5xx. A completeness self-check enumerates the route tree and fails if a `withAuthenticatedApi` GET route is added without a case or a documented skip, so the net can't silently rot. This is the regression net for unscoped-query / tenant-guard failures (the class that caused a production incident on 2026-07-10). It runs in CI, where `TEST_DATABASE_URL` is set against the pgvector Postgres image.

## Known follow-ups (tracked tech debt)

- **Drop the legacy `KnowledgeChunk.embedding` Json column.** Ingest no longer writes it (retrieval reads only `embeddingVec`); drop the column in a future migration once pre-cutover deploys are gone. `AgentMemory.embedding` is NOT legacy — `bestAnswerMatch` still reads it for remembered-answer matching; migrating that to pgvector is the prerequisite for dropping it.
- ~~Re-embed NULL-vector rows~~ **Done:** the nightly retention cron runs `reEmbedMissingVectors` (`src/lib/rag/re-embed.ts`), backfilling `embeddingVec IS NULL` memories/chunks in bounded batches whenever embeddings are configured.
- **Flow-editor reducer (WS-R6 Phase 2, deferred).** `src/app/flows/[id]/page.tsx` is a 1,186-line god-component with 26 `useState` hooks and manual undo/redo. It should carve into a typed reducer + context, but that refactor needs a React component-test harness first (none exists — all tests are `.test.ts` logic tests) so it's regression-covered; see `docs/superpowers/plans/2026-07-10-remediation-ws6-route-smoke-harness.md`.
- ~~MCP transport consolidation~~ **Done:** `klavis-client.ts` and `sublime-mcp.ts` were removed with the Klavis migration, and the orphaned `streamable-http.ts` duplicate is deleted — `src/lib/mcp/mcp-client.ts` is the single MCP transport (auth modes: none / api-key / oauth2).
- **Per-org credentials for built-in tools.** Slack, Granola, and Email are keyed to single global env vars, so every organization shares one account — acceptable single-tenant, blocking for multi-tenant. The per-user `Integration` table already exists and should hold these.
- **Tool-discovery caching.** `loadTools` runs `initialize` + `tools/list` against every server on every run (drops past the per-server 20 / global 64 caps are now logged). Cache the discovered tool lists (the Klavis path already persists them for the capability cards) and run discovery in parallel.
- **Frontend data layer.** Pages fetch with raw `fetch` + `useState` + `setInterval`; shared domain types now live in `src/lib/types.ts`, but a query cache (e.g. TanStack Query) would remove the hand-rolled polling, refetch-everything mutations, and the `AGENTS_CHANGED_EVENT` window-event bus.
