# Architecture

## Runtime Boundary

There are two runtimes:

1. **Next.js**: pages, authentication, CRUD APIs, integration management, execution inspection, and external trigger endpoints.
2. **Worker**: one Fastify process with BullMQ consumers for manual, scheduled, webhook-triggered, and resumed agent runs.

Pipedream owns embedded account connections; Klavis owns agent-facing MCP tool servers. Model access goes through `src/lib/llm/model-runner.ts`, which routes `claude-*` models to the Anthropic SDK and everything else to OpenAI, and falls back to whichever provider's key is configured so a run never hard-fails on a missing vendor. Defaults are OpenAI: the agent model is `AGENT_MODEL` (default `gpt-4o`) and cheap surfaces (run Q&A, activity headlines, the natural-language agent builder) use `SUMMARY_MODEL` (default `gpt-4o-mini`). Set a `claude-*` model plus `ANTHROPIC_API_KEY` to use Anthropic.

## Agent Execution

1. Runs are enqueued by `POST /api/agents/:id/execute` (manual), the BullMQ job schedulers reconciled in `agent-schedule-registrar.ts` (hourly/daily/weekly/cron), or `POST /api/agents/:id/trigger` (webhook, authenticated by a per-agent secret).
2. The worker loads the agent and its active Klavis MCP connections, then runs a model tool-calling loop (max `AGENT_MAX_TURNS`, default 16). Each tool call is persisted as a `WorkflowStep` and `WorkflowEvent`; token usage accumulates on the execution.
3. The loop always exposes an `ask_user` tool. When the model calls it, the run pauses: the provider-native transcript is persisted on the execution, status becomes `waiting_for_input`, and the question is stored as an `ExecutionMessage`.
4. `POST /api/executions/:id/reply` records the user's answer and enqueues a resume job; the worker replays the saved transcript, feeds the answer back as the tool result, and continues.
5. Output or failure is persisted on the execution and surfaced by Agent HQ. `POST /api/chat` answers follow-up questions about a finished run; `GET /api/usage` reports month-to-date token usage per organization.

`POST /api/agents/draft` turns a plain-language description into an agent configuration (structured output) and can create the agent directly.

## Shared Server Utilities

- `src/lib/prisma.ts`: process-wide Prisma client
- `src/lib/server/auth.ts`: required Supabase user and tenant context
- `src/lib/server/api-handler.ts`: authenticated API wrapper and consistent errors
- `src/lib/supabase/middleware.ts`: session refresh and page protection

All tenant data queries must include `organizationId`. The only session-less API route is the agent trigger endpoint, which authenticates with a per-agent secret.

## Core Data

`prisma/schema.prisma` intentionally contains only organizations, users, agents, executions, execution messages, workflow steps/events, templates, integrations, and Klavis MCP connections. Executions carry the resumable model transcript, token counts, and the model that ran them.

## Known follow-ups (tracked tech debt)

- **MCP transport consolidation.** There are three near-duplicate MCP clients — `klavis-client.ts`, `mcp-client.ts`, and `den-mcp.ts` — each reimplementing JSON-RPC, SSE parsing, session handling, and the initialize handshake. They should collapse into one transport with pluggable auth (none / api-key / oauth2-client-credentials / oauth2-authcode / static-bearer). The `MCPAgent` (Klavis, per-user) vs `McpConnection` (custom, per-org) model split is the same divide surfacing in the schema.
- **Per-org credentials for built-in tools.** Slack, Granola, and Email are keyed to single global env vars, so every organization shares one account — acceptable single-tenant, blocking for multi-tenant. The per-user `Integration` table already exists and should hold these.
- **Tool-discovery caching.** `loadTools` runs `initialize` + `tools/list` against every server on every run (drops past the per-server 20 / global 64 caps are now logged). Cache the discovered tool lists (the Klavis path already persists them for the capability cards) and run discovery in parallel.
- **Frontend data layer.** Pages fetch with raw `fetch` + `useState` + `setInterval`; shared domain types now live in `src/lib/types.ts`, but a query cache (e.g. TanStack Query) would remove the hand-rolled polling, refetch-everything mutations, and the `AGENTS_CHANGED_EVENT` window-event bus.
