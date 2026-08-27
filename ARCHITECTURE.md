# Architecture

## Runtime Boundary

There are two runtimes:

1. **Next.js**: pages, authentication, CRUD APIs, integration management, execution inspection, and external trigger endpoints.
2. **Worker**: one Fastify process with BullMQ consumers for manual, scheduled, webhook-triggered, and resumed agent runs.

Both runtimes report errors through `src/lib/observability/sentry.ts`; the worker initializes it at boot (tagged `process: worker`) and flushes on shutdown.

Nango owns embedded account connections and deployed integration actions; user-added MCP servers connect through `src/lib/mcp/`. Two integrations are **native** because Nango cannot carry them: Google (which blocks Nango's consent flow) and Postgres (which Nango has no provider for). Both mirror themselves into `nango_connections` — `provider: 'google-native'` / `'postgres-native'` — so the integrations grid, `/api/nango/status`, the tool plane, and the scan plane read one table regardless of who owns the credential. Model access goes through `src/lib/llm/model-runner.ts`: both Claude and Qwen speak the Anthropic Messages wire (Qwen via `QWEN_BASE_URL`), and `routeModel` orders the endpoint chain with a cross-endpoint fallback so a run never hard-fails on a missing vendor. Defaults are Anthropic: the agent model is `AGENT_MODEL` (default `claude-sonnet-5`) and cheap surfaces (run Q&A, activity headlines, the natural-language agent builder) use `SUMMARY_MODEL` (default `claude-haiku-4-5`). Set `QWEN_API_KEY` + `QWEN_BASE_URL` to enable the Qwen endpoint.

## Agent Execution

1. Runs are enqueued by `POST /api/agents/:id/execute` (manual), the BullMQ job schedulers reconciled in `agent-schedule-registrar.ts` (hourly/daily/weekly/cron), or `POST /api/agents/:id/trigger` (webhook, authenticated by a per-agent secret).
2. The worker loads the agent and its active Klavis MCP connections, then runs a model tool-calling loop (max `AGENT_MAX_TURNS`, default 16). Each tool call is persisted as a `WorkflowStep` and `WorkflowEvent`; token usage accumulates on the execution.
3. The loop always exposes an `ask_user` tool. When the model calls it, the run pauses: the provider-native transcript is persisted on the execution, status becomes `waiting_for_input`, and the question is stored as an `ExecutionMessage`.
4. `POST /api/executions/:id/reply` records the user's answer and enqueues a resume job; the worker replays the saved transcript, feeds the answer back as the tool result, and continues.
5. Output or failure is persisted on the execution and surfaced by Agent HQ. `POST /api/chat` answers follow-up questions about a finished run; `GET /api/usage` reports month-to-date token usage per organization.

`POST /api/agents/draft` turns a plain-language description into an agent configuration (structured output) and can create the agent directly.

**Agent permissions.** An agent runs with a human's credentials but under its OWN grant (`AgentTask.grants`, `src/lib/agents/grants.ts`): per plane, `read`, `write`, or `blocked`, with `*` as the wildcard. The grant is enforced at tool discovery in `loadTools` — a forbidden tool is never offered to the model, so there is nothing for injected content to steer toward — and at the configured-HTTP-endpoint site the discovery path bypasses. Classification prefers MCP `readOnlyHint`/`destructiveHint` annotations, then the registry's read-only planes, then the tool name, defaulting to write. `null` is a legacy row and means unrestricted, so no existing agent changed when this shipped; new agents default to `{ '*': 'read' }`, and template/import provisioning grants write only on the planes the spec declared. Grants are read from the live row, never the published snapshot, because a permission change must bind the very next run. Only the owner or an admin may change them. Audit rows written by a run carry `actorAgentId` alongside the human `actorUserId`. Known boundary: a read-only agent may still delegate via `run_agent` to a sub-agent that holds write grants — the sub-agent's own grant governs its tools, and `allowSubagents`/`subagentIds` is the owner's control over that.

**External agents (BYOA).** `AgentTask.runtime = 'external'` plus an `ExternalAgentBinding` (endpoint, encrypted auth, callback deadline) makes an agent a teammate whose work runs elsewhere. `runAgentExecution` branches after the execution row exists: the ask is POSTed to the endpoint (`src/lib/agents/external-agent.ts` — SSRF-vetted on save and on every dispatch, connection pinned to the vetted address) with a per-run single-use callback token; a `200 { output }` settles the run inline, a `202` parks it as `waiting_for_external` until `POST /api/agents/[id]/external/callback` settles it (session-less, authenticated by the token whose hash the settle write clears), and a cron sweep fails parked runs past their deadline. Settling reuses the AgentRequest path, so the answer lands on the request, the goal, and the Slack thread exactly as a native run's would. The reverse direction — an external agent addressing a Sublime agent — is the workspace MCP server's `ask_agent`/`get_request` tools. Contract: `docs/external-agents.md`.

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

Goals are a first-class measurement spine: `Goal` declares the target, `GoalMetric` binds it to a source of truth, `MetricDatapoint` preserves the observed series, and `GoalContribution` attributes agent/flow work without inventing causality. The connector registry in `src/lib/metrics/` reads Stripe, HubSpot, Salesforce, Google Sheets, Postgres, or manual values; `/api/cron/dispatch` refreshes due bindings and evaluates pace. Recommendations are transition-gated: only a change into `at_risk` or `off_track` emits a `goal_action` `UserSuggestion`, preventing repeated cron ticks from spamming the same advice.

Goal tracking meets users where they are: beyond the exact connectors, `src/lib/metrics/` carries a deterministic URL source (SSRF-guarded at three layers — literal checks, DNS-resolution vetting per redirect hop, worker shares a network with Redis) and AI-assisted Slack/Gmail sources (`src/lib/metrics/assisted-extraction.ts`, summary-model extraction that throws on low confidence rather than fabricate; readings persist with origin `'assisted'` and render as "AI-read"). CSV history imports via `POST /api/goals/[id]/datapoints/import`. The goal kind dictates the unit (`GOAL_KIND_UNITS`), and 20 static goal templates (`src/lib/goals/goal-templates.ts`) prefill the wizard from `/goals`.

Recurring goals advance a sliding window over the same Goal row: settlement writes an immutable `GoalPeriod` and moves `startAt`/`targetDate`/`startValue` in one transaction (capped catch-up, empty windows settle `missed`). Goal context feeds prompts through `goalGroundingBlock` (assistant, agent runs, copilot); a Monday digest (`src/lib/goals/digest.ts`) fans out bell + push + email under an atomic per-user weekly claim. The proof layer's estimated tier is calibrated from human edits only (`GoalContribution.estimateEdited` provenance — provision-time calibrated defaults never feed back into the median), measured AI run time comes from one shared loader (`contributionRunStats`), and `GET /api/goals/report` streams a board-ready PDF whose figures carry the same measured/estimated/correlated labels as the app. `GoalBenchmark` (global, like `PlatformArchetype`) aggregates exact per-kind outcome counts weekly and surfaces only at ≥ 5 distinct orgs.

Organization deletion is complete: every org-owned model cascades via FK (WS-R4 closed the gaps — flows, push subscriptions, knowledge, shared skills), and `teardownOrganization` (`src/lib/org-teardown.ts`) deprovisions external Klavis/Nango resources and clears the org's Neo4j nodes before deleting the row. The daily retention cron prunes `run:`/`signal:` graph nodes in lockstep with the Postgres rows it deletes.

Knowledge and agent-memory retrieval rank in-database with pgvector: each carries an `embeddingVec vector(1024)` column with an HNSW cosine index, and retrieval is a `<=>` distance query over all of an org's rows (no in-memory scan / 500-row cap). Reads/writes go through raw SQL wrapped in `SET LOCAL search_path = public, extensions` so the `vector` type resolves on Supabase. The legacy `embedding Json` columns are still written for deploy-window safety and are slated to drop (see follow-ups).

## Postgres Integration

An org connects any number of named databases (`PostgresConnection`, org-scoped, admin-managed). One tile on `/integrations` links to `/integrations/postgres`; the same panel renders inside a connect dialog on the goal wizard and the agent bundle, so an unconnected integration is fixed where the user hit it instead of by navigating away.

All three consumers — the agent/flow tool plane (`postgres:<id>`), the goal metric source, and the intelligence scan — go through one hardened path in `src/lib/postgres/`:

- **Layer 0** (`client.ts`): the connection string is parsed and reduced to explicit client config, so a credential carrying `?options=-c default_transaction_read_only=off` can never reach the driver. Verified TLS is mandatory off-loopback with no opt-out; a private CA goes in the connection's `caCert`.
- **Layer 1** (`sql-policy.ts`): single statement, no semicolons (which is what makes chaining impossible, including through a value interpolated into a flow node's SQL), SELECT/WITH-only on the read path, and INSERT/UPDATE/DELETE-only on the write path — DDL stays forbidden even when writes are enabled, and an unqualified UPDATE/DELETE is refused.
- **Layer 2** (`client.ts`): reads execute inside a server-enforced `BEGIN TRANSACTION READ ONLY`, which is immune to pooler startup-packet drops and connection-string overrides alike. `postgres-integration-e2e.test.ts` proves this independently with `SELECT … INTO`, which passes the denylist and only the server refuses.

Writes require **two** independent human decisions: someone enabled `allowWrites` on that database (a column, not a field inside the encrypted blob, so the tool catalog never decrypts a secret to read a policy flag), and — for agent runs — someone approved the exact statement. That second gate does not use the per-agent `requireApproval` flag, which defaults off; the `postgres:write` plane carries `alwaysRequiresApproval` in the connector registry instead. Flow steps do not pause, because a flow's SQL is authored by a human in the builder rather than generated by a model.

The scan plane brings its own sampler (`postgres/scan.ts`) rather than the generic empty-args tool sampling, which cannot work for a tool that needs SQL. It introspects the schema and samples a bounded number of rows from the largest tables; row values reach the summary model, the distillation prompt forbids quoting them verbatim, and an org can switch it off per database with the Learning toggle.

## Testing

Most logic is unit-tested with `node:test` (`npm test`). API routes are additionally smoke-tested end to end: `src/app/api/__tests__/route-smoke.test.ts` invokes each `withAuthenticatedApi`-wrapped GET handler (all but three that require an external service, which are explicitly skipped) against a seeded test DB — via a production-inert auth seam in `src/lib/server/auth.ts` (`setTestAuthContext`, gated on `NODE_ENV !== 'production' && TEST_DATABASE_URL`) — and fails on any 5xx. A completeness self-check enumerates the route tree and fails if a `withAuthenticatedApi` GET route is added without a case or a documented skip, so the net can't silently rot. This is the regression net for unscoped-query / tenant-guard failures (the class that caused a production incident on 2026-07-10). It runs in CI, where `TEST_DATABASE_URL` is set against the pgvector Postgres image.

## Known follow-ups (tracked tech debt)

- **Drop the legacy `KnowledgeChunk.embedding` Json column.** Ingest no longer writes it (retrieval reads only `embeddingVec`); drop the column in a future migration once pre-cutover deploys are gone. `AgentMemory.embedding` is NOT legacy — `bestAnswerMatch` still reads it for remembered-answer matching; migrating that to pgvector is the prerequisite for dropping it.
- ~~Re-embed NULL-vector rows~~ **Done:** the nightly retention cron runs `reEmbedMissingVectors` (`src/lib/rag/re-embed.ts`), backfilling `embeddingVec IS NULL` memories/chunks in bounded batches whenever embeddings are configured.
- **Flow-editor reducer (WS-R6 Phase 2, deferred).** `src/app/flows/[id]/page.tsx` is a 1,186-line god-component with 26 `useState` hooks and manual undo/redo. It should carve into a typed reducer + context, but that refactor needs a React component-test harness first (none exists — all tests are `.test.ts` logic tests) so it's regression-covered; see `docs/superpowers/plans/2026-07-10-remediation-ws6-route-smoke-harness.md`.
- ~~MCP transport consolidation~~ **Done:** `klavis-client.ts` and `sublime-mcp.ts` were removed with the Klavis migration, and the orphaned `streamable-http.ts` duplicate is deleted — `src/lib/mcp/mcp-client.ts` is the single MCP transport (auth modes: none / api-key / oauth2).
- **Per-org credentials for built-in tools.** Slack, Granola, and Email are keyed to single global env vars, so every organization shares one account — acceptable single-tenant, blocking for multi-tenant. The per-user `Integration` table already exists and should hold these.
- **Tool-discovery caching.** `loadTools` runs `initialize` + `tools/list` against every server on every run (drops past the per-server 20 / global 64 caps are now logged). Cache the discovered tool lists (the Klavis path already persists them for the capability cards) and run discovery in parallel.
- **Frontend data layer.** Pages fetch with raw `fetch` + `useState` + timers; shared domain types live in `src/lib/types.ts`, and `use-cached-json` provides SWR/dedupe/persistence for the shell surfaces. A full query-cache adoption (e.g. TanStack Query) would still remove the refetch-everything mutations and the `AGENTS_CHANGED_EVENT` window-event bus — but it is deliberately NOT being introduced piecemeal: two competing caches is worse than one hand-rolled one, and converting the complex pages safely needs the React component-test harness (same prerequisite as the flow-editor reducer above). Sequence: harness → flow-editor reducer → query-cache migration, replacing `use-cached-json` wholesale. The urgency dropped once run-status delivery went push-based (realtime broadcasts + poll backoff): polling is now the fallback, not the transport.

## Scale hardening (2026-07-31)

A four-track audit (DB/connections, shared-state/scaling, settings
persistence, stability) drove a hardening pass targeting 100+ concurrent
users. What changed, at the architecture level:

- **Queue plane:** producers use a bounded Redis connection (commands reject
  in ~5s instead of retrying forever) and process-wide `getQueue()`
  singletons; the worker runs per-queue concurrency (env-tunable, default 10
  for agent/flow queues), pauses + force-closes within the platform's SIGTERM
  window, and dead-letters every genuinely-failed job (a redelivered job
  whose row is already `failed` rethrows instead of resolving). Dead-letter
  queues are pruned by the retention cron; `/api/health` reports queue depths.
- **Run lifecycle:** pending→running claims are atomic and status-guarded
  (a reaped/cancelled row can never be resurrected); resumes refresh
  `startedAt`; the stuck-run threshold exceeds lockDuration×2; the pending
  reaper verifies the BullMQ job is actually gone before failing a row; flow
  stall redelivery consults the step ledger so completed side effects replay
  as no-ops. Reaper sweeps are indexed (`agent_executions(status, startedAt)`,
  `agent_tasks(status)`).
- **Cron dispatch:** every background sweep goes through `afterResponse()`
  (never a bare `void` — Vercel freezes those with the response), per-org
  fan-outs are bounded (`mapWithConcurrency`), scans are ordered and
  self-rotating, and every cap logs saturation instead of silently dropping.
- **Abuse/limits:** `withAuthenticatedApi` takes a declarative `rateLimit`
  (per-user + per-org) applied to all LLM-calling routes; `emitFlowSignal`
  dispatches through the queue; the month-budget aggregate is cached 60s.
- **Settings:** `organizations.settings` writes are atomic key-level jsonb
  merges (`src/lib/server/org-settings.ts`); scan exclusions use add/remove
  verbs; profile PATCH invalidates the auth cache; workspace-wide settings
  writes require `settings:workspace`.
- **External coupling:** Neo4j/Nango/LLM one-shot/web-push/Resend calls all
  carry explicit deadlines; `maxDuration` values reflect Vercel's real
  ceiling (800).
- **Boot assertions:** `assertServerEnv` verifies the pooled DATABASE_URL
  shape; the worker runs `assertWorkerEnv` (fails on missing core env, warns
  on missing SENTRY_DSN/VAPID keys and pool-vs-concurrency mismatches). See
  `docs/runbooks/migrations.md` for the expand/contract deploy rule.

A same-day Tier-2 pass closed two of the deferred items: **run delivery is
now push-based** (`run-events:<orgId>` private Realtime topic; broadcasts on
agent/flow transitions from `src/lib/realtime/run-events.ts`, `useRunEvents`
kicks the existing polls, polling is the fallback transport) and **flow
triggers are denormalized** (`triggerType`/`triggerKey`/`isPublished`
maintained by a Postgres BEFORE trigger; activity/Slack/signal ingestion and
the scheduling tick match listeners in indexed SQL instead of loading every
active flow's published graph per event).

Still deliberately deferred (product/infra decisions, not code gaps):
cross-device preference sync (theme/sidebar/favorites are localStorage by
design), per-tenant code-execution isolation (Pyodide/vm run
process-global), a second worker replica (unblocked by the registrar lock,
but a deploy action), the goals-create transaction loops (bounded by schema
limits), and the query-cache migration (see Frontend data layer above).
