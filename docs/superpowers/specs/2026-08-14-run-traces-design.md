# Run Traces: Unified Agent + Flow Observability

**Date:** 2026-08-14
**Status:** Approved

## Goal

A workspace-level `/traces` surface where every agent execution and flow run
is one stream: what ran, what tools it called, what the RAG layer retrieved
(strategy, query, scored hits, what was actually injected), and what it cost.
`/activity` is untouched — it stays the connected-tool business ledger
(`ActivityEvent`); traces are about what **our** automations did, not what
the org's tools did.

## Decisions (locked)

- **New unified `/traces` surface**, not a rebuild of `/activity`, not
  deepened per-agent/per-flow panes only.
- **Full retrieval trace**: strategy, query text, per-hit scores, stage
  funnel, injected-token counts.
- **All plans, all members** — no plan gate, no admin gate. Visibility equals
  what members already see on the agent and flow run surfaces.
- **Architecture A — projection.** No new tables, no dual-writes. Traces are
  a read-model over the existing run stores; the only writer change is
  richer RAG event payloads.

## Why projection works here

The trace data already exists, split across two runtimes:

| | Agent runs | Flow runs |
| --- | --- | --- |
| Run row | `AgentExecution` (tokens, model, error, timing) | `FlowRun` (status, trigger, timing) |
| Steps | `WorkflowStep` (tool calls: node, input, output, error) | `FlowRunStep` (node, status, io, `agentExecutionId`, `iterationPath`) |
| Events | `WorkflowEvent` (`agent.thinking`, `context.retrieved`, `knowledge.retrieved`, `agent.plan`, `memory.retrieved`, `agent.question.autoanswered`, …) | — |
| Tool provenance | via step node ids | `FlowSideEffect` (provider, operation, safety, attempts, providerRequestId) |

Both run tables index `[organizationId, startedAt]`, so a merged
newest-first list is two indexed range reads per page. `FlowRunStep.
agentExecutionId` links a flow's agent step to that agent's full execution —
the cross-store join that makes the unified view more than cosmetic.
Because traces **are** the run records, nothing can drift and run pruning
stays single-sourced.

## 1. Trace envelope — `src/lib/traces/`

Pure, fetch-free, no React (the `process-feed.ts` discipline).

### `envelope.ts`

```ts
type TraceStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped'

type TraceSummary = {
  id: string
  kind: 'agent' | 'flow'
  name: string                  // agent name/type, or flow name
  status: TraceStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  tokens: { input: number; output: number } | null   // null for flows with no agent steps
  costUsd: number | null        // tokens × workspace per-M rate; null when tokens null
  toolCallCount: number
  hasRetrieval: boolean         // any context/knowledge retrieval event
  trigger: string | null        // normalized trigger type label
  error: string | null
}
```

Status normalization (single mapping table, unit-tested):

- Agent: `pending→queued`, `running→running`, `waiting*→waiting`,
  `completed→succeeded`, `failed→failed`, `cancelled/cancelling→stopped`;
  unknown strings → `running` if `completedAt` is null else `failed`
  (fail-soft, never throw).
- Flow: `queued/claimed→queued`, `running→running`, `waiting→waiting`,
  `succeeded→succeeded`, `failed→failed`, `stopping/stopped→stopped`.
- The exact source-status strings are enumerated from
  `lib/agents/run-status.ts` and the `FlowRun.status` comment at
  implementation time; the vocabulary above is the contract.

### `spans.ts`

```ts
type TraceSpan =
  | { kind: 'thinking';  ts: number; text: string }
  | { kind: 'plan';      ts: number; text: string }
  | { kind: 'retrieval'; ts: number; channel: 'graph-rag' | 'knowledge'
      strategy: string            // 'vector' | 'vector+graph' | 'vector+rerank+graph'
      query: string | null        // null for legacy events that predate enrichment
      hits: Array<{ type: string; text: string; score: number | null }>
      related: Array<{ type: string; text: string }>
      stages: RetrievalStages | null   // legacy events: null → UI hides funnel
      injected: { count: number; ofCandidates: number; tokens: number } | null }
  | { kind: 'memory';    ts: number; summary: string }
  | { kind: 'autoanswer';ts: number; question: string; answer: string }
  | { kind: 'tool';      ts: number; step: ProcessToolStep }              // agent WorkflowStep
  | { kind: 'step';      ts: number; node: string; status: TraceStatus    // flow node
      iterationPath: string | null
      input?: unknown; output?: unknown; error: string | null
      effects: Array<{ provider: string; operation: string
        safety: 'read' | 'idempotent_write' | 'unsafe_write'
        status: string; attempts: number }> }
  | { kind: 'subagent';  ts: number; nodeId: string; trace: TraceDetail } // nested agent run
  | { kind: 'unknown';   ts: number; label: string }   // malformed payload fail-soft

type TraceDetail = { summary: TraceSummary; spans: TraceSpan[] }
```

### Mappers

- `traceFromAgentExecution(execution, events, steps, rates)` — supersedes the
  event-shaping half of `buildProcessTimeline`; `process-feed.ts` keeps its
  compact-line rendering and re-exports shared types so the existing agent
  pane and flow runs panel compile unchanged.
- `traceFromFlowRun(run, steps, effects, childTraces, rates)` — steps sorted
  by `(order, iterationPath)`; a step with `agentExecutionId` whose child
  trace was loaded becomes a `subagent` span (falls back to a plain `step`
  span if the child was pruned). Flow-level tokens/cost = sum over child
  agent traces; `null` when there are none.
- Malformed event payloads map to `unknown` spans — a trace never throws.
- `rates` (hourly rate, per-M-token cost) come from the same workspace
  settings the impact model reads; cost math reuses the constant, not a copy.

## 2. API

### `GET /api/traces`

`withAuthenticatedApi`, `requires: 'member'`, runtime nodejs. No plan gate.

- Query params: `kind` (`agent|flow`), `status` (normalized vocabulary,
  mapped back to source statuses per store), `q` (name substring,
  case-insensitive), `from`/`to` (ISO), `cursor`, page size fixed at 25.
- Merge: query each store newest-first (25 each), k-way merge on
  `startedAt desc, id desc`, take 25.
- Cursor: base64 JSON `{ a: [startedAtISO, id] | null, f: [startedAtISO, id] | null }`
  per-source high-water marks — each page stays two indexed range reads and
  neither source starves the other. `null` side = exhausted.
- Row payload: `TraceSummary` + the flow/agent id needed for links.
  `toolCallCount` via `_count` on steps; flow token/cost columns are omitted
  in list rows (loading child executions per row would be N+1 — detail only).
- Name search: agent runs match on agent task/template name via the join the
  executions list endpoint already uses; flow runs on `Flow.name`.

### `GET /api/traces/agent/[id]` · `GET /api/traces/flow/[id]`

- Org-scoped lookup; missing or foreign rows → **404, never 403**.
- Agent detail: execution + events + steps → `TraceDetail`.
- Flow detail: run + steps + effects, then **one** batched
  `agentExecution` query for all `agentExecutionId`s (plus their events and
  steps, batched by `executionId IN …`) → nested `subagent` spans. Depth is
  one level: a subagent's own subflows render as links, not inline trees.

## 3. RAG instrumentation (the only writer change)

### `retrieveContext()` — additive `trace` return field

```ts
type RetrievalStages = {
  candidates: number        // raw vector hits before the score floor
  afterScoreFloor: number
  reranked: boolean         // Voyage rerank ran
  afterRerank: number       // == afterScoreFloor when reranked is false
  graphSeeds: number
  relatedFound: number
  relatedKept: number       // after maxNodes trim
}
// RetrievedContext gains: trace: RetrievalStages & { minScore, topK, hops }
```

Existing callers (`assistant-context.ts`, `intelligence-context.ts`) ignore
the new field — no breakage. `hits[]` already carries `score`; unchanged.

### Enriched `context.retrieved` payload (`execute-agent.ts`)

Current payload keeps its fields (back-compat: old events still render).
Added: `strategy` (derived from stages: rerank ran? graph expanded?),
`query` (the same ≤2000-char string passed to retrieval), per-hit `score`
(returned today, dropped at the emit — now kept), `stages`
(the funnel above), and `injected: { count, ofCandidates, tokens }` from the
`contextAssembler` budget (kept vs. offered, token estimate).

`knowledge.retrieved` gains the same treatment: per-chunk `score`, `query`,
and `injected` counts alongside the existing filenames.

Both payloads live in `WorkflowEvent.payload` (Json) — **no schema change**,
pruning inherited. Sensitivity is unchanged in kind: hit text is already
persisted; the query is the agent objective + run input, which members
already see on the run detail.

## 4. UI

### `/traces` (workspace-level, `src/app/(app)/traces/`)

Beside `/activity` for the same reason activity sits there: runs are an org
stream with no goal dimension. Sidebar nav item next to Activity.

- **List page:** filter chips (kind; normalized status), name search box,
  time presets (24h / 7d / 30d / all). Row: kind icon (Bot/Workflow), name,
  status badge (existing badge variants), started relative time, duration,
  tokens + cost when present, tool-call count, retrieval indicator.
  Cursor-based "Load more". Loading skeletons; error state; empty state
  ("Runs will appear here when your agents and flows do work").
- **Detail page `/traces/[kind]/[id]`:** header (name, status, duration,
  trigger, tokens, cost, error banner when failed) over a `TraceTimeline`
  (`src/components/traces/trace-timeline.tsx`) rendering the span union:
  - retrieval spans: strategy line, query, stage funnel
    (`12 candidates → 7 ≥ floor → 5 reranked → 3 injected (2.1k tokens)`),
    scored hits expandable;
  - tool/step spans: status dot, provider/operation (+ safety chip from
    `FlowSideEffect`), input/output/error collapsed behind a toggle;
  - subagent spans: summary row expanding inline to the child timeline.
  - Live runs poll the detail endpoint (the agent pane's refresh pattern);
    no new realtime channel.

### Cross-links, not rebuilds

The agent activity pane and the flow run activity table each get a
"View trace →" link into `/traces/...`. Their in-place rendering stays;
migrating them onto `TraceTimeline` is an explicit non-goal of this branch.

## 5. Errors & testing

- **Mappers:** status-normalization table (every known source status +
  unknown-string fallbacks), agent mapping (events + steps interleave,
  legacy `context.retrieved` payload without stages), flow mapping
  (iterationPath ordering, effects attachment, pruned-child fallback),
  malformed payload → `unknown` span, never throw.
- **Merge cursor:** interleaved sources, one source exhausted, stable
  ordering on equal timestamps (id tiebreak).
- **Routes:** list filtering + pagination; detail shapes; cross-org and
  missing ids → 404; member (non-admin) can read.
- **`retrieveContext` trace:** extend `src/lib/rag/__tests__` — stage counts
  through floor and rerank paths, trace present when retrieval is disabled
  (zeros, not undefined).
- **UI:** loading/error/empty states; axe-clean per the current a11y gate
  (feed uses list semantics; expandable regions are buttons with
  `aria-expanded`).

## Out of scope

- Any change to `/activity` or `ActivityEvent`.
- New realtime delivery for live traces (polling only).
- Migrating the agent pane / flow runs panel onto `TraceTimeline`.
- Cost accounting beyond the existing per-M-token model.
- Retention/pruning changes; traces live exactly as long as their run rows.
