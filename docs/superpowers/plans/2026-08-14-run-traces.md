# Run Traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace-level `/traces` surface unifying agent executions and flow runs into one stream with per-run drill-down: tools called, RAG retrieval (strategy, query, scored hits, stage funnel), context injected, tokens and cost.

**Architecture:** Pure projection — no new tables, no dual writes. `src/lib/traces/` normalizes the existing run stores (`AgentExecution`+`WorkflowStep`+`WorkflowEvent`, `FlowRun`+`FlowRunStep`+`FlowSideEffect`) into a `TraceSummary`/`TraceSpan` envelope. `GET /api/traces` k-way-merges the two stores behind a per-source high-water-mark cursor. The only writer change is enriching the `context.retrieved` / `knowledge.retrieved` event payloads with the retrieval telemetry `retrieveContext()` already computes but discards.

**Tech Stack:** Next.js App Router, Prisma, node:test via tsx (`npm test`), Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-08-14-run-traces-design.md`

## Global Constraints

- Branch: `feat/run-traces`; commit per task.
- **Visibility is per-user, not org-wide:** agent runs filter through `executionVisibilityScope(userId)` (= `{ userId }`), flow runs through `workspaceFlowRunScope(userId)` (= `{ OR: [{ userId }, { userId: null, flow: { userId } }] }`), both from `@/lib/server/visibility` and always combined with `organizationId`. The traces surface must never show a run its viewer couldn't see on the existing surfaces.
- Missing/foreign rows → **404, never 403**.
- No plan gate; `requires: 'member'` on every route.
- Normalized status vocabulary: `queued | running | waiting | succeeded | failed | stopped`. Mappers never throw — unknown inputs degrade (statuses fall back by terminal-ness; malformed payloads become `unknown` spans).
- Agent source statuses (from `src/lib/agents/run-status.ts` + schema defaults): `pending`, `running`, `waiting_for_input`, `completed`, `failed`, `cancelled`, `cancelling`. Flow source statuses (schema comment): `queued`, `claimed`, `running`, `waiting`, `stopping`, `stopped`, `succeeded`, `failed`.
- Token→cost: `(inputTokens + outputTokens) / 1_000_000 × aiCostPerMTokensUsd` — the rate read the same way `impact.ts` reads it (org `settings`, default 10).
- Token estimate for injected context: `chars / 4` (documented in `src/lib/context/assemble.ts`).
- Flow lists exclude `node_test` trigger runs (match `/api/flows/runs`).
- `/activity`, `ActivityEvent`, and the existing panes' rendering are untouched except for added "View trace →" links.
- ESLint/a11y ratchet must not gain new entries.

---

### Task 1: Trace envelope — types + status normalization

**Files:**
- Create: `src/lib/traces/envelope.ts`
- Test: `src/lib/traces/__tests__/envelope.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type TraceStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped'`
  - `type TraceKind = 'agent' | 'flow'`
  - `type TraceSummary = { id: string; kind: TraceKind; name: string; status: TraceStatus; startedAt: string; finishedAt: string | null; durationMs: number | null; tokens: { input: number; output: number } | null; costUsd: number | null; toolCallCount: number; hasRetrieval: boolean; trigger: string | null; error: string | null }`
  - `normalizeAgentStatus(status: string, completedAt: Date | string | null): TraceStatus`
  - `normalizeFlowStatus(status: string, finishedAt: Date | string | null): TraceStatus`
  - `fmtDurationMs(ms: number | null): string` (`—`, `840ms`, `4.2s`, `3m 12s`, `1h 4m`)
  - `costUsdOf(inputTokens: number, outputTokens: number, perMTokensUsd: number): number`

- [ ] **Step 1: Write the failing tests**

`src/lib/traces/__tests__/envelope.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAgentStatus, normalizeFlowStatus, fmtDurationMs, costUsdOf } from '../envelope'

test('agent status table', () => {
  assert.equal(normalizeAgentStatus('pending', null), 'queued')
  assert.equal(normalizeAgentStatus('running', null), 'running')
  assert.equal(normalizeAgentStatus('waiting_for_input', null), 'waiting')
  assert.equal(normalizeAgentStatus('completed', new Date()), 'succeeded')
  assert.equal(normalizeAgentStatus('failed', new Date()), 'failed')
  assert.equal(normalizeAgentStatus('cancelled', new Date()), 'stopped')
  assert.equal(normalizeAgentStatus('cancelling', null), 'stopped')
})

test('unknown agent status degrades by terminal-ness, never throws', () => {
  assert.equal(normalizeAgentStatus('someday_new_status', null), 'running')
  assert.equal(normalizeAgentStatus('someday_new_status', new Date()), 'failed')
})

test('flow status table', () => {
  assert.equal(normalizeFlowStatus('queued', null), 'queued')
  assert.equal(normalizeFlowStatus('claimed', null), 'queued')
  assert.equal(normalizeFlowStatus('running', null), 'running')
  assert.equal(normalizeFlowStatus('waiting', null), 'waiting')
  assert.equal(normalizeFlowStatus('succeeded', new Date()), 'succeeded')
  assert.equal(normalizeFlowStatus('failed', new Date()), 'failed')
  assert.equal(normalizeFlowStatus('stopping', null), 'stopped')
  assert.equal(normalizeFlowStatus('stopped', new Date()), 'stopped')
  assert.equal(normalizeFlowStatus('brand_new', null), 'running')
  assert.equal(normalizeFlowStatus('brand_new', new Date()), 'failed')
})

test('fmtDurationMs', () => {
  assert.equal(fmtDurationMs(null), '—')
  assert.equal(fmtDurationMs(840), '840ms')
  assert.equal(fmtDurationMs(4200), '4.2s')
  assert.equal(fmtDurationMs(192_000), '3m 12s')
  assert.equal(fmtDurationMs(3_840_000), '1h 4m')
})

test('costUsdOf', () => {
  assert.equal(costUsdOf(600_000, 400_000, 10), 10)
  assert.equal(costUsdOf(0, 0, 10), 0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/traces/__tests__/envelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/traces/envelope.ts`**

```ts
/**
 * The shared trace vocabulary: one status set and one summary shape over both
 * run stores (AgentExecution, FlowRun). Pure — no Prisma, no React — so both
 * API routes and UI import it freely. Normalization NEVER throws: an unknown
 * source status degrades by terminal-ness so a new runtime status renders as
 * a live/failed run instead of crashing the trace surface.
 */

export type TraceStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped'
export type TraceKind = 'agent' | 'flow'

export type TraceSummary = {
  id: string
  kind: TraceKind
  name: string
  status: TraceStatus
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  /** Null for flow runs with no agent steps (flows themselves consume no tokens). */
  tokens: { input: number; output: number } | null
  costUsd: number | null
  toolCallCount: number
  hasRetrieval: boolean
  trigger: string | null
  error: string | null
}

const AGENT_STATUS: Record<string, TraceStatus> = {
  pending: 'queued',
  running: 'running',
  waiting_for_input: 'waiting',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'stopped',
  cancelling: 'stopped',
}

const FLOW_STATUS: Record<string, TraceStatus> = {
  queued: 'queued',
  claimed: 'queued',
  running: 'running',
  waiting: 'waiting',
  succeeded: 'succeeded',
  failed: 'failed',
  stopping: 'stopped',
  stopped: 'stopped',
}

const fallback = (finished: Date | string | null): TraceStatus => (finished ? 'failed' : 'running')

export function normalizeAgentStatus(status: string, completedAt: Date | string | null): TraceStatus {
  return AGENT_STATUS[status] ?? fallback(completedAt)
}

export function normalizeFlowStatus(status: string, finishedAt: Date | string | null): TraceStatus {
  return FLOW_STATUS[status] ?? fallback(finishedAt)
}

/** `—`, `840ms`, `4.2s`, `3m 12s`, `1h 4m`. */
export function fmtDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Same cost model as lib/goals/impact.ts: tokens / 1M × the workspace rate. */
export function costUsdOf(inputTokens: number, outputTokens: number, perMTokensUsd: number): number {
  return ((inputTokens + outputTokens) / 1_000_000) * perMTokensUsd
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/traces/__tests__/envelope.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/traces
git commit -m "feat(traces): trace envelope — status normalization, summary shape"
```

---

### Task 2: Retrieval telemetry in `retrieveContext()`

**Files:**
- Modify: `src/lib/rag/retrieve.ts` (the `retrieveContext` function, lines 71-140)
- Test: `src/lib/rag/__tests__/retrieve.test.ts` (extend; read it first to reuse its fake store/embed helpers)

**Interfaces:**
- Consumes: existing internals of `retrieveContext` (searchHits before/after floor, rerank result, `related` before/after trim).
- Produces (exported from `retrieve.ts`):
  - `type RetrievalTrace = { candidates: number; afterScoreFloor: number; reranked: boolean; afterRerank: number; graphSeeds: number; relatedFound: number; relatedKept: number; minScore: number; topK: number; hops: number }`
  - `RetrievedContext` gains a required `trace: RetrievalTrace` field. **Check every constructor of `RetrievedContext`:** the early return (embeddings disabled) and the final return both must populate it; `rg -n "hits: \[\], related: \[\]" src/lib/rag` to find any other empty-pack constructors (e.g. in `get-store.ts` fallbacks) and update them.

- [ ] **Step 1: Write the failing tests**

Extend `src/lib/rag/__tests__/retrieve.test.ts`, reusing its existing fake-store pattern (whatever it names it — adapt these to the file's local helpers):

```ts
test('trace records the stage funnel through the score floor', async () => {
  // Fake store returning 3 hits: scores 0.9, 0.5, 0.1 (floor is 0.25).
  const context = await retrieveContext(storeWithScores([0.9, 0.5, 0.1]), {
    organizationId: 'org', query: 'q', embed: fakeEmbed, rerank: async () => null,
  })
  assert.equal(context.trace.candidates, 3)
  assert.equal(context.trace.afterScoreFloor, 2)
  assert.equal(context.trace.reranked, false)
  assert.equal(context.trace.afterRerank, 2)
})

test('trace is zeros (not undefined) when retrieval is disabled', async () => {
  // No embed option and ragEnabled() false → early return path.
  const context = await retrieveContext(emptyStore(), { organizationId: 'org', query: 'q' })
  assert.deepEqual(context.trace.candidates, 0)
  assert.equal(context.trace.reranked, false)
})

test('trace counts graph expansion: found vs kept after maxNodes trim', async () => {
  const context = await retrieveContext(storeWithRelated(20), {
    organizationId: 'org', query: 'q', embed: fakeEmbed, maxNodes: 5, rerank: async () => null,
  })
  assert.equal(context.trace.relatedFound, 20)
  assert.equal(context.trace.relatedKept, 5)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/rag/__tests__/retrieve.test.ts`
Expected: FAIL — `trace` undefined.

- [ ] **Step 3: Implement**

In `retrieveContext`, thread counters through the existing pipeline (no behavior change to retrieval itself):

```ts
// After the vector search:
const candidates = searchHits.length
// After the minScore filter:
const afterScoreFloor = searchHits.length
// After the optional rerank block:
const reranked = /* true only when rerank() returned a ranking */
const afterRerank = searchHits.length
// After expand():
const relatedFound = related.length
// After the trim:
const relatedKept = relatedTrimmed.length

const trace: RetrievalTrace = {
  candidates, afterScoreFloor, reranked, afterRerank,
  graphSeeds: seedIds.length, relatedFound, relatedKept,
  minScore, topK, hops,
}
```

The early return becomes:

```ts
if (!ragEnabled() && !options.embed) {
  return { hits: [], related: [], trace: emptyRetrievalTrace(topK, hops, minScore) }
}
```

with `emptyRetrievalTrace` exported (zeros + the passed knobs). Note the early return currently sits ABOVE the `minScore` resolution — hoist `const minScore = options.minScore ?? 0.25` above it so both paths share it. Update any other `RetrievedContext` constructors found in Step 1's interface note.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/rag/__tests__/retrieve.test.ts` → PASS.
Then the callers still compile: `npx tsc --noEmit` → clean (callers ignore the new field).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rag
git commit -m "feat(rag): retrieveContext returns stage-funnel telemetry"
```

---

### Task 3: Enriched retrieval event payloads

**Files:**
- Create: `src/lib/rag/retrieval-event.ts`
- Modify: `src/features/agents/execute-agent.ts` (the `context.retrieved` emit ~line 945; the `knowledge.retrieved` emit ~line 970)
- Test: `src/lib/rag/__tests__/retrieval-event.test.ts`

**Interfaces:**
- Consumes: `RetrievalTrace` (Task 2); the budgeted hit/related arrays and `contextAssembler` at the emit sites.
- Produces:
  - `buildContextRetrievedPayload(input: { query: string; trace: RetrievalTrace; hits: Array<{ type: string; text: string; score: number }>; related: Array<{ type: string; text: string }>; offeredHits: number; injectedChars: number }): ContextRetrievedPayload`
  - `ContextRetrievedPayload = { source: 'graph-rag'; strategy: string; query: string; hits: Array<{ type: string; text: string; score: number }>; related: Array<{ type: string; text: string }>; stages: RetrievalTrace; injected: { count: number; ofCandidates: number; tokens: number }; summary: string }`
  - `buildKnowledgeRetrievedPayload(input: { query: string; chunks: Array<{ filename: string; score: number }>; offered: number; injectedChars: number }): { source: 'retained-knowledge'; query: string; files: string[]; chunks: Array<{ filename: string; score: number }>; injected: { count: number; ofCandidates: number; tokens: number }; summary: string }`
  - Strategy derivation: `'vector'` + (`+rerank` when `trace.reranked`) + (`+graph` when `trace.graphSeeds > 0`), e.g. `vector+rerank+graph`.

- [ ] **Step 1: Write the failing tests**

`src/lib/rag/__tests__/retrieval-event.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextRetrievedPayload, buildKnowledgeRetrievedPayload } from '../retrieval-event'

const trace = {
  candidates: 12, afterScoreFloor: 7, reranked: true, afterRerank: 5,
  graphSeeds: 5, relatedFound: 9, relatedKept: 4, minScore: 0.25, topK: 6, hops: 2,
}

test('strategy derives from the funnel', () => {
  const payload = buildContextRetrievedPayload({
    query: 'renewal risk for Acme', trace,
    hits: [{ type: 'opportunity', text: 'Acme renewal', score: 0.87 }],
    related: [], offeredHits: 5, injectedChars: 8400,
  })
  assert.equal(payload.strategy, 'vector+rerank+graph')
  assert.equal(payload.injected.count, 1)
  assert.equal(payload.injected.ofCandidates, 5)
  assert.equal(payload.injected.tokens, 2100) // chars/4
  assert.ok(payload.summary.includes('1'))
})

test('strategy is plain vector when nothing else ran', () => {
  const payload = buildContextRetrievedPayload({
    query: 'q', trace: { ...trace, reranked: false, graphSeeds: 0 },
    hits: [], related: [], offeredHits: 0, injectedChars: 0,
  })
  assert.equal(payload.strategy, 'vector')
})

test('knowledge payload keeps filenames unique and scores per chunk', () => {
  const payload = buildKnowledgeRetrievedPayload({
    query: 'pricing', offered: 6, injectedChars: 2000,
    chunks: [
      { filename: 'deck.pdf', score: 0.8 },
      { filename: 'deck.pdf', score: 0.7 },
      { filename: 'notes.md', score: 0.6 },
    ],
  })
  assert.deepEqual(payload.files, ['deck.pdf', 'notes.md'])
  assert.equal(payload.chunks.length, 3)
  assert.equal(payload.injected.tokens, 500)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/rag/__tests__/retrieval-event.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/rag/retrieval-event.ts`**

```ts
/**
 * WorkflowEvent payload builders for retrieval events. Pure so the payload
 * shape is unit-tested; execute-agent supplies the live values. Old events
 * (pre-enrichment) lack strategy/stages/injected — every reader must treat
 * those fields as optional (the trace mappers type them nullable).
 */
import type { RetrievalTrace } from '@/lib/rag/retrieve'

/** chars ≈ tokens × 4 — the assemble.ts budget's own documented estimate. */
const tokensOf = (chars: number) => Math.round(chars / 4)

export type ContextRetrievedPayload = {
  source: 'graph-rag'
  strategy: string
  query: string
  hits: Array<{ type: string; text: string; score: number }>
  related: Array<{ type: string; text: string }>
  stages: RetrievalTrace
  injected: { count: number; ofCandidates: number; tokens: number }
  summary: string
}

export function buildContextRetrievedPayload(input: {
  query: string
  trace: RetrievalTrace
  hits: Array<{ type: string; text: string; score: number }>
  related: Array<{ type: string; text: string }>
  offeredHits: number
  injectedChars: number
}): ContextRetrievedPayload {
  const strategy = ['vector', input.trace.reranked ? 'rerank' : null, input.trace.graphSeeds > 0 ? 'graph' : null]
    .filter(Boolean)
    .join('+')
  return {
    source: 'graph-rag',
    strategy,
    query: input.query,
    hits: input.hits,
    related: input.related,
    stages: input.trace,
    injected: { count: input.hits.length, ofCandidates: input.offeredHits, tokens: tokensOf(input.injectedChars) },
    summary: `Pulled ${input.hits.length} correlated fact(s) + ${input.related.length} connected entit(ies) from Sales AI, integrations, and prior runs.`,
  }
}

export function buildKnowledgeRetrievedPayload(input: {
  query: string
  chunks: Array<{ filename: string; score: number }>
  offered: number
  injectedChars: number
}) {
  return {
    source: 'retained-knowledge' as const,
    query: input.query,
    files: [...new Set(input.chunks.map((chunk) => chunk.filename))],
    chunks: input.chunks,
    injected: { count: input.chunks.length, ofCandidates: input.offered, tokens: tokensOf(input.injectedChars) },
    summary: `Pulled ${input.chunks.length} passage(s) from ${new Set(input.chunks.map((chunk) => chunk.filename)).size} retained source(s).`,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass, then wire the emits**

Run: `npx tsx --test src/lib/rag/__tests__/retrieval-event.test.ts` → PASS.

In `src/features/agents/execute-agent.ts` at the `context.retrieved` emit (~line 945), replace the inline payload object:

```ts
await recordEvent(execution.id, null, 'context.retrieved',
  buildContextRetrievedPayload({
    query,                              // the same sliced string passed to retrieveContext
    trace: ragContext.trace,
    hits: budgeted.hits.map((h) => ({ type: h.type, text: h.text, score: h.score })),
    related: budgeted.related.map((r) => ({ type: r.type, text: r.text })),
    offeredHits: ragContext.hits.length,
    injectedChars: rendered.length,
  }))
```

(The current emit drops `score`; keep it now. `query` is already computed a few lines up as `` `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000) `` — assign it to a local const used by both the retrieval call and the payload.)

At the `knowledge.retrieved` emit (~line 970):

```ts
await recordEvent(execution.id, null, 'knowledge.retrieved',
  buildKnowledgeRetrievedPayload({
    query,
    chunks: budgetedKnowledge.map((h) => ({ filename: h.filename, score: h.score })),
    offered: knowledgeHits.length,
    injectedChars: knowledgeBlock.length,
  }))
```

Then: `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rag src/features/agents/execute-agent.ts
git commit -m "feat(traces): enrich retrieval events with strategy, scores, funnel"
```

---

### Task 4: Span mappers

**Files:**
- Create: `src/lib/traces/spans.ts`
- Test: `src/lib/traces/__tests__/spans.test.ts`

**Interfaces:**
- Consumes: `TraceSummary`, `TraceStatus`, `normalizeAgentStatus`, `normalizeFlowStatus`, `costUsdOf` (Task 1); `ProcessToolStep`, `ProcessEvent` types from `@/lib/agents/process-feed`; `RetrievalTrace` (Task 2).
- Produces:
  - `type TraceSpan =` the union: `thinking`, `plan`, `retrieval` (`channel: 'graph-rag' | 'knowledge'`; `query/stages/injected` nullable for legacy events), `memory`, `autoanswer`, `tool` (`step: ProcessToolStep`), `step` (flow node with `effects`), `subagent` (`nodeId`, `trace: TraceDetail`), `unknown` — exactly as written in the spec §1 `spans.ts` block; copy the field lists from the spec verbatim.
  - `type TraceDetail = { summary: TraceSummary; spans: TraceSpan[] }`
  - `traceFromAgentExecution(execution: AgentExecutionRow, events: ProcessEvent[], steps: ProcessToolStep[], opts: { name: string; perMTokensUsd: number }): TraceDetail` where `AgentExecutionRow = { id: string; status: string; startedAt: Date | string; completedAt: Date | string | null; inputTokens: number; outputTokens: number; error: string | null; trigger: unknown }`
  - `traceFromFlowRun(run: FlowRunRow, steps: FlowStepRow[], effects: FlowEffectRow[], children: Map<string, TraceDetail>, opts: { name: string }): TraceDetail` where `FlowRunRow = { id: string; status: string; startedAt: Date | string; finishedAt: Date | string | null; error: string | null; trigger: unknown }`, `FlowStepRow = { id: string; nodeId: string; agentExecutionId: string | null; iterationPath: string | null; order: number; status: string; input?: unknown; output?: unknown; error: string | null; startedAt: Date | string | null; finishedAt: Date | string | null }`, `FlowEffectRow = { flowRunStepId: string; provider: string; operation: string; safety: string; status: string; attempts: number }`
  - Summary rules: agent `toolCallCount = steps.length`, `tokens = { input, output }`, `costUsd` via `costUsdOf`; flow `toolCallCount = steps.length`, `tokens`/`costUsd` = sum over `children` values (null when no children); `hasRetrieval` = any `retrieval` span (always false for flows without children; a flow with children is true if any child has one); `trigger` = `(trigger as { type?: string })?.type ?? null`.

- [ ] **Step 1: Write the failing tests**

`src/lib/traces/__tests__/spans.test.ts` (representative set — implement all):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceFromAgentExecution, traceFromFlowRun } from '../spans'

const execution = {
  id: 'e1', status: 'completed',
  startedAt: '2026-08-14T00:00:00Z', completedAt: '2026-08-14T00:01:00Z',
  inputTokens: 900_000, outputTokens: 100_000, error: null, trigger: { type: 'manual' },
}

test('agent: events and steps interleave chronologically; summary math', () => {
  const events = [
    { id: 'ev1', kind: 'agent.thinking', payload: { text: 'hm' }, ts: '2026-08-14T00:00:10Z' },
    { id: 'ev2', kind: 'context.retrieved', payload: { summary: 's', hits: [], related: [] }, ts: '2026-08-14T00:00:05Z' },
  ]
  const steps = [{ id: 's1', node: 'slack.send', status: 'succeeded', startedAt: '2026-08-14T00:00:20Z' }]
  const detail = traceFromAgentExecution(execution, events, steps, { name: 'Renewal agent', perMTokensUsd: 10 })
  assert.deepEqual(detail.spans.map((s) => s.kind), ['retrieval', 'thinking', 'tool'])
  assert.equal(detail.summary.status, 'succeeded')
  assert.equal(detail.summary.costUsd, 10)
  assert.equal(detail.summary.toolCallCount, 1)
  assert.equal(detail.summary.hasRetrieval, true)
  assert.equal(detail.summary.durationMs, 60_000)
})

test('agent: legacy context.retrieved (no stages) maps with nulls, not throws', () => {
  const events = [{ id: 'ev', kind: 'context.retrieved', payload: { summary: 's', hits: [{ type: 't', text: 'x' }], related: [] }, ts: '2026-08-14T00:00:05Z' }]
  const detail = traceFromAgentExecution(execution, events, [], { name: 'a', perMTokensUsd: 10 })
  const span = detail.spans[0]
  assert.equal(span.kind, 'retrieval')
  if (span.kind === 'retrieval') {
    assert.equal(span.stages, null)
    assert.equal(span.query, null)
    assert.equal(span.hits[0].score, null)
  }
})

test('agent: malformed payload becomes an unknown span, never throws', () => {
  const events = [{ id: 'ev', kind: 'agent.thinking', payload: 'not-an-object' as never, ts: 'garbage-date' }]
  const detail = traceFromAgentExecution(execution, events, [], { name: 'a', perMTokensUsd: 10 })
  assert.equal(detail.spans.length, 1)
})

test('flow: steps order by (order, iterationPath); effects attach; subagent nests', () => {
  const run = { id: 'r1', status: 'succeeded', startedAt: '2026-08-14T00:00:00Z', finishedAt: '2026-08-14T00:02:00Z', error: null, trigger: { type: 'schedule' } }
  const steps = [
    { id: 'st2', nodeId: 'loop.body', agentExecutionId: null, iterationPath: '1', order: 2, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
    { id: 'st1', nodeId: 'loop.body', agentExecutionId: null, iterationPath: '0', order: 2, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
    { id: 'st0', nodeId: 'agent.step', agentExecutionId: 'e1', iterationPath: null, order: 1, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
  ]
  const effects = [{ flowRunStepId: 'st1', provider: 'slack', operation: 'send_message', safety: 'unsafe_write', status: 'succeeded', attempts: 1 }]
  const child = traceFromAgentExecution(execution, [], [], { name: 'child', perMTokensUsd: 10 })
  const detail = traceFromFlowRun(run, steps, effects, new Map([['e1', child]]), { name: 'My flow' })
  assert.deepEqual(detail.spans.map((s) => s.kind), ['subagent', 'step', 'step'])
  const first = detail.spans[1]
  if (first.kind === 'step') assert.equal(first.effects[0].provider, 'slack')
  assert.deepEqual(detail.summary.tokens, { input: 900_000, output: 100_000 })
})

test('flow: pruned child (id not in map) falls back to a plain step span', () => {
  const run = { id: 'r1', status: 'succeeded', startedAt: '2026-08-14T00:00:00Z', finishedAt: null, error: null, trigger: null }
  const steps = [{ id: 'st', nodeId: 'agent.step', agentExecutionId: 'gone', iterationPath: null, order: 1, status: 'succeeded', error: null, startedAt: null, finishedAt: null }]
  const detail = traceFromFlowRun(run, steps, [], new Map(), { name: 'f' })
  assert.equal(detail.spans[0].kind, 'step')
  assert.equal(detail.summary.tokens, null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/traces/__tests__/spans.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/lib/traces/spans.ts`**

Copy the span union from the spec §1 verbatim. Implementation notes (write real code, these are the rules):

- One `mapEvent(event): TraceSpan | null` switch mirroring `buildProcessTimeline`'s kinds (`agent.thinking`, `agent.plan`, `context.retrieved`, `knowledge.retrieved`, `memory.retrieved`, `agent.question.autoanswered`); wrap the whole mapping in `try/catch` returning `{ kind: 'unknown', ts, label: event.kind }` on any throw; `ts` from `new Date(event.ts).getTime()` with `Number.isNaN → 0`.
- `context.retrieved` → `retrieval` span, `channel: 'graph-rag'`; read `payload.stages ?? null`, `payload.query ?? null`, `payload.injected ?? null`; hit scores `typeof h.score === 'number' ? h.score : null`. `knowledge.retrieved` → `channel: 'knowledge'`, hits from `payload.chunks ?? []` (`type: 'file'`, `text: filename`).
- Agent spans: mapped events + `steps.map(step => ({ kind: 'tool', ts: …, step }))`, sorted by `ts`.
- Flow spans: sort steps by `(order, iterationPath ?? '')` (string compare is fine — iterationPath segments are dot-joined indices); group `effects` by `flowRunStepId`; a step with `agentExecutionId` present in `children` becomes `{ kind: 'subagent', ts, nodeId, trace }`, else a `step` span with its effects.
- Summaries per the Interfaces block above; durations `finishedAt − startedAt` (null while running); dates serialized with `new Date(x).toISOString()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/traces/__tests__/spans.test.ts` → PASS. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/traces
git commit -m "feat(traces): agent + flow run mappers into the span envelope"
```

---

### Task 5: Merge cursor

**Files:**
- Create: `src/lib/traces/merge.ts`
- Test: `src/lib/traces/__tests__/merge.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type TraceCursor = { a: [string, string] | null; f: [string, string] | null }` — per-source `[startedAtISO, id]` high-water marks; `null` = source exhausted.
  - `encodeCursor(cursor: TraceCursor): string` (base64url JSON) / `decodeCursor(raw: string | null): TraceCursor | null` (malformed → `null`, treated as first page).
  - `mergeTracePages<T extends { startedAt: string; id: string; kind: 'agent' | 'flow' }>(agentRows: T[], flowRows: T[], pageSize: number): { rows: T[]; next: TraceCursor | null }` — merge on `startedAt desc, id desc`; `next` carries the high-water mark per source (last row of that source that made the page, or the incoming mark if none did); `next` is `null` when both sources are exhausted (fewer than pageSize rows fetched AND all merged rows fit).

- [ ] **Step 1: Write the failing tests**

`src/lib/traces/__tests__/merge.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeCursor, decodeCursor, mergeTracePages } from '../merge'

const row = (kind: 'agent' | 'flow', id: string, startedAt: string) => ({ kind, id, startedAt })

test('merges newest-first with id tiebreak', () => {
  const { rows } = mergeTracePages(
    [row('agent', 'a2', '2026-08-14T00:00:02Z'), row('agent', 'a1', '2026-08-14T00:00:01Z')],
    [row('flow', 'f9', '2026-08-14T00:00:02Z'), row('flow', 'f1', '2026-08-14T00:00:00Z')],
    10,
  )
  // Equal timestamps: id desc — 'f9' > 'a2'.
  assert.deepEqual(rows.map((r) => r.id), ['f9', 'a2', 'a1', 'f1'])
})

test('page cap produces per-source high-water marks', () => {
  const { rows, next } = mergeTracePages(
    [row('agent', 'a3', '2026-08-14T00:00:03Z'), row('agent', 'a1', '2026-08-14T00:00:01Z')],
    [row('flow', 'f2', '2026-08-14T00:00:02Z'), row('flow', 'f0', '2026-08-14T00:00:00Z')],
    2,
  )
  assert.deepEqual(rows.map((r) => r.id), ['a3', 'f2'])
  assert.deepEqual(next, { a: ['2026-08-14T00:00:03Z', 'a3'], f: ['2026-08-14T00:00:02Z', 'f2'] })
})

test('one source exhausted: its mark is null and merging continues', () => {
  const { rows, next } = mergeTracePages([], [row('flow', 'f1', '2026-08-14T00:00:00Z')], 5)
  assert.deepEqual(rows.map((r) => r.id), ['f1'])
  assert.equal(next, null) // both fit → no next page
})

test('cursor roundtrip; malformed decodes to null', () => {
  const cursor = { a: ['2026-08-14T00:00:03Z', 'a3'] as [string, string], f: null }
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor)
  assert.equal(decodeCursor('%%%not-base64%%%'), null)
  assert.equal(decodeCursor(null), null)
})
```

- [ ] **Step 2: Run tests to verify they fail** → module not found.

- [ ] **Step 3: Implement `src/lib/traces/merge.ts`**

```ts
/**
 * Per-source keyset pagination for the merged trace stream. A single shared
 * timestamp cursor would re-scan the denser store's tail on every page; a
 * high-water mark PER SOURCE keeps each page two indexed range reads
 * (startedAt desc, id desc — same tiebreak discipline as /api/flows/runs).
 */

export type TraceCursor = { a: [string, string] | null; f: [string, string] | null }

export function encodeCursor(cursor: TraceCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

/** Malformed cursors decode to null → first page (rows may age out; never error). */
export function decodeCursor(raw: string | null): TraceCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const mark = (value: unknown): [string, string] | null =>
      Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string'
        ? [value[0], value[1]]
        : null
    return { a: mark(parsed?.a), f: mark(parsed?.f) }
  } catch {
    return null
  }
}

const after = (x: { startedAt: string; id: string }, y: { startedAt: string; id: string }) =>
  x.startedAt > y.startedAt || (x.startedAt === y.startedAt && x.id > y.id)

export function mergeTracePages<T extends { startedAt: string; id: string; kind: 'agent' | 'flow' }>(
  agentRows: T[],
  flowRows: T[],
  pageSize: number,
): { rows: T[]; next: TraceCursor | null } {
  const merged: T[] = []
  let ai = 0
  let fi = 0
  while (merged.length < pageSize && (ai < agentRows.length || fi < flowRows.length)) {
    const a = agentRows[ai]
    const f = flowRows[fi]
    if (a && (!f || after(a, f))) {
      merged.push(a)
      ai += 1
    } else if (f) {
      merged.push(f)
      fi += 1
    }
  }
  const exhausted = ai >= agentRows.length && fi >= flowRows.length
  if (exhausted) return { rows: merged, next: null }
  const lastA = ai > 0 ? agentRows[ai - 1] : null
  const lastF = fi > 0 ? flowRows[fi - 1] : null
  return {
    rows: merged,
    next: {
      a: lastA ? [lastA.startedAt, lastA.id] : null,
      f: lastF ? [lastF.startedAt, lastF.id] : null,
    },
  }
}
```

Note on `next` semantics: a `null` side means "no mark yet for that source" — the route treats it as "source may still have rows from the top"; combined with the query's own `startedAt < mark` filter this is safe because a source with no consumed rows keeps its previous mark (the route passes the incoming mark through when the merge consumed nothing from that source — implement that in the route, Task 6).

- [ ] **Step 4: Run tests to verify they pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/traces
git commit -m "feat(traces): per-source high-water-mark merge pagination"
```

---

### Task 6: `GET /api/traces` list route

**Files:**
- Create: `src/app/api/traces/route.ts`
- Test: `src/app/api/traces/__tests__/traces-route.pg.test.ts`

**Interfaces:**
- Consumes: `normalizeAgentStatus`, `normalizeFlowStatus`, `costUsdOf`, `TraceSummary` (Task 1); `encodeCursor`, `decodeCursor`, `mergeTracePages` (Task 5); `executionVisibilityScope`, `workspaceFlowRunScope` from `@/lib/server/visibility`; `withAuthenticatedApi`; prisma.
- Produces: `GET /api/traces?kind&status&q&cursor` → `{ success: true, traces: Array<TraceSummary & { resource: { agentTaskId?: string | null; flowId?: string } }>, cursor: string | null }`, newest-first, page of 25.

- [ ] **Step 1: Write the failing route test**

`src/app/api/traces/__tests__/traces-route.pg.test.ts` — same TEST_DATABASE_URL-guarded harness as `work-route.test.ts` (`seedTestOrg`, `installTestAuth`). Seed: one `agentExecution` (`status: 'completed'`, `completedAt` set, `inputTokens: 1000, outputTokens: 500`, `userId: seeded.userId`), one `flow` + `flowRun` (`status: 'succeeded'`, `userId: seeded.userId`), one `flowRun` with `trigger: { type: 'node_test' }`, and one `agentExecution` owned by a second user. Assert:

```ts
test('merged list: both kinds, newest first, node_test and other-user runs absent', async () => {
  const { GET } = await import('@/app/api/traces/route')
  const response = await GET(new NextRequest('http://test/api/traces'), { params: Promise.resolve({}) } as any)
  const body = await response.json()
  assert.equal(response.status, 200)
  const kinds = body.traces.map((t: any) => t.kind).sort()
  assert.deepEqual(kinds, ['agent', 'flow'])            // node_test + foreign run excluded
  assert.ok(body.traces.every((t: any) => ['queued','running','waiting','succeeded','failed','stopped'].includes(t.status)))
})

test('kind and status filters narrow the stream', async () => {
  const { GET } = await import('@/app/api/traces/route')
  const response = await GET(new NextRequest('http://test/api/traces?kind=agent&status=succeeded'), { params: Promise.resolve({}) } as any)
  const body = await response.json()
  assert.ok(body.traces.every((t: any) => t.kind === 'agent' && t.status === 'succeeded'))
})

test('cursor pages without repeating rows', async () => {
  // Seed 30 more flow runs, then walk two pages of 25 and assert disjoint ids.
})
```

- [ ] **Step 2: Run test to verify it fails** → route module missing.

- [ ] **Step 3: Implement `src/app/api/traces/route.ts`**

Shape (write it fully):

```ts
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope, workspaceFlowRunScope } from '@/lib/server/visibility'
import { normalizeAgentStatus, normalizeFlowStatus, costUsdOf, type TraceStatus } from '@/lib/traces/envelope'
import { decodeCursor, encodeCursor, mergeTracePages } from '@/lib/traces/merge'

export const runtime = 'nodejs'

const PAGE = 25

/** Normalized → source statuses, per store. Unknown filter values match nothing. */
const AGENT_STATUSES: Record<TraceStatus, string[]> = {
  queued: ['pending'], running: ['running'], waiting: ['waiting_for_input'],
  succeeded: ['completed'], failed: ['failed'], stopped: ['cancelled', 'cancelling'],
}
const FLOW_STATUSES: Record<TraceStatus, string[]> = {
  queued: ['queued', 'claimed'], running: ['running'], waiting: ['waiting'],
  succeeded: ['succeeded'], failed: ['failed'], stopped: ['stopping', 'stopped'],
}

// GET /api/traces — the unified run stream. Projection only: visibility is
// exactly the run stores' own rules (your runs; ownerless runs of flows you
// own), so this surface can never show more than the panes it unifies.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const searchParams = request.nextUrl.searchParams
  const kind = searchParams.get('kind')                 // 'agent' | 'flow' | null
  const status = searchParams.get('status') as TraceStatus | null
  const q = searchParams.get('q')?.trim() || null
  const cursor = decodeCursor(searchParams.get('cursor'))
  // Time range: invalid dates are ignored (filter chips only ever send valid ISO).
  const parseDate = (value: string | null) => {
    const date = value ? new Date(value) : null
    return date && !Number.isNaN(date.getTime()) ? date : null
  }
  const from = parseDate(searchParams.get('from'))
  const to = parseDate(searchParams.get('to'))
  const startedAtRange = from || to ? { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}

  const wantAgents = kind !== 'flow'
  const wantFlows = kind !== 'agent'

  const [executions, flowRuns] = await Promise.all([
    wantAgents
      ? prisma.agentExecution.findMany({
          where: {
            organizationId: auth.organizationId,
            ...executionVisibilityScope(auth.dbUser.id),
            ...startedAtRange,
            ...(status ? { status: { in: AGENT_STATUSES[status] ?? [] } } : {}),
            ...(q ? { agentTask: { description: { contains: q, mode: 'insensitive' } } } : {}),
            ...(cursor?.a
              ? { OR: [
                  { startedAt: { lt: new Date(cursor.a[0]) } },
                  { startedAt: new Date(cursor.a[0]), id: { lt: cursor.a[1] } },
                ] }
              : {}),
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: {
            id: true, status: true, startedAt: true, completedAt: true,
            inputTokens: true, outputTokens: true, error: true, trigger: true,
            agentType: true, agentTaskId: true,
            agentTask: { select: { description: true, metadata: true } },
            _count: { select: { workflowSteps: true } },
          },
        })
      : [],
    wantFlows
      ? prisma.flowRun.findMany({
          where: {
            organizationId: auth.organizationId,
            ...workspaceFlowRunScope(auth.dbUser.id),
            ...startedAtRange,
            NOT: { trigger: { path: ['type'], equals: 'node_test' } },
            ...(status ? { status: { in: FLOW_STATUSES[status] ?? [] } } : {}),
            ...(q ? { flow: { name: { contains: q, mode: 'insensitive' } } } : {}),
            ...(cursor?.f
              ? { AND: [{ OR: [
                  { startedAt: { lt: new Date(cursor.f[0]) } },
                  { startedAt: new Date(cursor.f[0]), id: { lt: cursor.f[1] } },
                ] }] }
              : {}),
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: {
            id: true, status: true, startedAt: true, finishedAt: true,
            error: true, trigger: true, flowId: true,
            flow: { select: { name: true } },
            _count: { select: { steps: true } },
          },
        })
      : [],
  ])
  // NOTE: workspaceFlowRunScope returns an OR and the cursor adds another —
  // hence the AND wrapper on the flow cursor clause (two OR keys collide in
  // one object; see the visibility module's header comment). The agent side
  // has no OR collision (executionVisibilityScope is a plain { userId }).

  const agentRows = executions.map((execution) => ({
    kind: 'agent' as const,
    id: execution.id,
    name:
      (execution.agentTask?.metadata as { title?: string } | null)?.title ||
      execution.agentTask?.description.split('\n')[0] ||
      execution.agentType,
    status: normalizeAgentStatus(execution.status, execution.completedAt),
    startedAt: execution.startedAt.toISOString(),
    finishedAt: execution.completedAt?.toISOString() ?? null,
    durationMs: execution.completedAt ? execution.completedAt.getTime() - execution.startedAt.getTime() : null,
    tokens: { input: execution.inputTokens, output: execution.outputTokens },
    costUsd: costUsdOf(execution.inputTokens, execution.outputTokens, rate),
    toolCallCount: execution._count.workflowSteps,
    hasRetrieval: false, // list rows skip the events read; the detail view knows
    trigger: (execution.trigger as { type?: string } | null)?.type ?? null,
    error: execution.error,
    resource: { agentTaskId: execution.agentTaskId },
  }))
  // flowRows analogous: tokens/costUsd null (children not loaded in lists),
  // toolCallCount = _count.steps, resource: { flowId }.

  const { rows, next } = mergeTracePages(agentRows, flowRows, PAGE)
  return { success: true, traces: rows, cursor: next ? encodeCursor(next) : null }
}, { requires: 'member' })
```

`rate` comes from a new export **added in this task** to `src/lib/goals/impact.ts`: `export async function costRateFor(organizationId: string): Promise<number>` — a thin wrapper over the existing private `settingsFor` returning `aiCostPerMTokensUsd` (default 10). Task 7's routes reuse it.

Cursor pass-through subtlety (from Task 5): when the merge consumed nothing from one source this page, keep that source's INCOMING mark in `next` rather than `null` — otherwise the next page would restart that source from the top. Implement by seeding `next.a ?? cursor?.a ?? null` (same for `f`) before encoding.

- [ ] **Step 4: Run test to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/traces
git commit -m "feat(traces): merged list endpoint over both run stores"
```

---

### Task 7: Detail routes

**Files:**
- Create: `src/app/api/traces/agent/[id]/route.ts`
- Create: `src/app/api/traces/flow/[id]/route.ts`
- Test: `src/app/api/traces/__tests__/trace-detail-routes.pg.test.ts`

**Interfaces:**
- Consumes: `traceFromAgentExecution`, `traceFromFlowRun` (Task 4); visibility scopes; prisma.
- Produces: `{ success: true, trace: TraceDetail }`; 404 JSON `{ success: false, error: 'Not found' }` for missing/foreign/invisible ids.

- [ ] **Step 1: Write the failing tests**

Same pg harness. Seed an execution with two `workflowEvent` rows (one legacy-shape `context.retrieved`, one `agent.thinking`) and one `workflowStep`; a flow run with a step pointing at that execution via `agentExecutionId` plus one `flowSideEffect`. Assert:

```ts
test('agent detail: spans present, retrieval span carries the legacy nulls', async () => { /* status 200; spans kinds ['retrieval','thinking','tool'] */ })
test('flow detail: subagent span nests the child trace; effects attached', async () => { /* spans include kind 'subagent' whose trace.summary.id === executionId */ })
test('foreign-org and other-user ids are 404, never 403', async () => { /* both routes */ })
```

- [ ] **Step 2: Run to verify failure** → modules missing.

- [ ] **Step 3: Implement both routes**

`agent/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'
import { traceFromAgentExecution } from '@/lib/traces/spans'
import { costRateFor } from '@/lib/goals/impact'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth, { params }) => {
  const { id } = await params
  const execution = await prisma.agentExecution.findFirst({
    where: { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
    omit: { transcript: true },
    include: { agentTask: { select: { description: true, metadata: true } } },
  })
  if (!execution) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const [events, steps] = await Promise.all([
    prisma.workflowEvent.findMany({ where: { executionId: id }, orderBy: { ts: 'asc' }, take: 500 }),
    prisma.workflowStep.findMany({ where: { executionId: id }, orderBy: { createdAt: 'asc' }, take: 300 }),
  ])
  const name =
    (execution.agentTask?.metadata as { title?: string } | null)?.title ||
    execution.agentTask?.description.split('\n')[0] ||
    execution.agentType
  const trace = traceFromAgentExecution(
    execution,
    events.map((e) => ({ id: e.id, kind: e.kind, payload: e.payload, ts: e.ts.toISOString() })),
    steps.map((s) => ({
      id: s.id, node: s.node, status: s.status, input: s.input, output: s.output,
      error: s.error, startedAt: s.startedAt?.toISOString() ?? null, completedAt: s.completedAt?.toISOString() ?? null,
    })),
    { name, perMTokensUsd: await costRateFor(auth.organizationId) },
  )
  return { success: true, trace }
}, { requires: 'member' })
```

(Adapt the `withAuthenticatedApi` handler's params signature to the repo's actual idiom — check how `src/app/api/goals/[id]/route.ts` receives route params and copy it.)

`flow/[id]/route.ts`: fetch the run via `findFirst` with `organizationId` + `workspaceFlowRunScope` (combined with `AND` since the scope is an `OR`), include `flow: { select: { name: true, userId: true } }`, its `steps` (ordered `order asc`) and `effects`. Batch children: `agentExecution.findMany({ where: { id: { in: stepAgentExecutionIds }, organizationId } })` — children are NOT re-filtered by user visibility (the flow run being visible makes its own child steps part of that story) — plus their events and steps `IN`-batched, grouped in JS, each run through `traceFromAgentExecution`. Then `traceFromFlowRun(run, steps, effects, childMap, { name: run.flow.name })`.

`costRateFor` already exists (exported from `impact.ts` in Task 6) — import it, don't redefine it.

- [ ] **Step 4: Run tests to verify they pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/traces src/lib/goals/impact.ts
git commit -m "feat(traces): agent + flow detail endpoints with nested subagent traces"
```

---

### Task 8: `/traces` list page + nav

**Files:**
- Create: `src/app/(app)/traces/page.tsx`
- Modify: `src/components/layout/sidebar.tsx` (nav array, line ~91)
- Test: build + lint (UI page; behavior is the API's, already covered)

**Interfaces:**
- Consumes: `GET /api/traces` (Task 6); `TraceSummary`, `fmtDurationMs` (Task 1); `PageHeader`, `EmptyState`, `Badge`, `Button`, `Skeleton` from `@/components/ui/*`; `IntegrationLogo` not needed; icons from lucide-react.
- Produces: the `/traces` route; nav entry.

- [ ] **Step 1: Nav entry**

In `src/components/layout/sidebar.tsx` after the Activity item (line 91):

```ts
  { name: 'Traces', href: '/traces', icon: ListTree, description: 'What your agents and flows did, step by step' },
```

Add `ListTree` to the lucide-react import. `/traces` is workspace-level like `/activity` — `scopedNavHref` leaves unscoped paths alone, so no other nav change is needed.

- [ ] **Step 2: Implement the page**

`src/app/(app)/traces/page.tsx` — `'use client'`. State: `traces: TraceRow[]`, `cursor: string | null`, `loading`, `error`, filters `kind`, `status`, `q` (debounced 300ms). Fetch: plain `fetch('/api/traces?' + params, { cache: 'no-store' })`; filter change resets the list; "Load more" appends with `cursor`. Structure:

```tsx
<PageHeader eyebrow="Workspace" icon={ListTree} title="Traces"
  description="Every agent and flow run — the tools they called, the context they retrieved, and what it cost." />
{/* Filter row: kind chips (All/Agents/Flows), status chips (All + 6 normalized), search input */}
{/* Rows: <ul> — each <li> a Link to /traces/{kind}/{id} with: kind icon (Bot|Workflow),
    name, status Badge (variant map: succeeded good, failed risk, running/queued info,
    waiting warn, stopped outline — the flow activity page's STATUS_BADGE idiom),
    relative started time, fmtDurationMs(durationMs), tokens+cost when non-null,
    toolCallCount ("4 tools"). */}
{/* Empty: <EmptyState icon={ListTree} title="No runs yet"
    description="Runs will appear here when your agents and flows do work." /> */}
{/* Footer: cursor && <Button variant="outline" onClick={loadMore}>Load more</Button> */}
```

Status chips send the normalized value as `status=`; kind chips `kind=agent|flow`. Every interactive element is a real `<button>`/`<a>`; the list is `<ul>/<li>` (a11y ratchet).

- [ ] **Step 3: Verify** — `npx tsc --noEmit && npm run lint && npx next build` (build may be deferred to Task 11 if slow; typecheck + lint now).

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/traces src/components/layout/sidebar.tsx
git commit -m "feat(traces): workspace trace explorer page + nav"
```

---

### Task 9: Trace detail page + `TraceTimeline`

**Files:**
- Create: `src/app/(app)/traces/[kind]/[id]/page.tsx`
- Create: `src/components/traces/trace-timeline.tsx`
- Test: build + lint; span rendering variants are exercised by Task 4's mapper tests (the component consumes their output verbatim).

**Interfaces:**
- Consumes: detail endpoints (Task 7); `TraceDetail`, `TraceSpan` (Task 4); `fmtDurationMs` (Task 1); `Markdown`, `Badge`, `Skeleton`, `EmptyState` UI components; `cn`.
- Produces: `TraceTimeline({ spans }: { spans: TraceSpan[] })` (exported — the panes may adopt it later); the detail route.

- [ ] **Step 1: Implement `TraceTimeline`**

One component, one `switch (span.kind)`:

- `thinking` → muted italic block with a Brain icon; `Markdown` for the text.
- `plan` → ListOrdered icon + `Markdown`.
- `retrieval` → card: header `Retrieved context — {channel}` + strategy chip; when `span.stages` non-null, the funnel line: `` `${stages.candidates} candidates → ${stages.afterScoreFloor} ≥ floor → ${stages.afterRerank}${stages.reranked ? ' reranked' : ''} → ${span.injected?.count ?? span.hits.length} injected${span.injected ? ` (${span.injected.tokens} tokens)` : ''}` ``; `span.query` in a collapsed `<details>` labeled "Query"; hits as rows `[score] type — text` (score `—` when null); related collapsed.
- `memory` / `autoanswer` → one-line rows (Lightbulb / HelpCircle icons).
- `tool` → status dot + node name; input/output/error each behind a native `<details>` with `<pre className="overflow-x-auto">` JSON.
- `step` → like `tool` plus `iterationPath` suffix (`loop.body · iteration 0.2`) and an effects row per effect: `IntegrationLogo`-style provider name, operation, safety chip (`read` outline / `idempotent_write` info / `unsafe_write` warn), attempts when > 1.
- `subagent` → summary row (name, status badge, duration) with a native `<details>`; body renders `<TraceTimeline spans={span.trace.spans} />` (one level deep by construction).
- `unknown` → muted row with the label.

Native `<details>/<summary>` keeps the a11y ratchet quiet (no aria-expanded wiring needed).

- [ ] **Step 2: Implement the detail page**

`src/app/(app)/traces/[kind]/[id]/page.tsx` — `'use client'`; `useParams()` for `kind`/`id`; guard `kind === 'agent' || kind === 'flow'` else render the EmptyState. Fetch `/api/traces/${kind}/${id}`; 404 → EmptyState ("Trace not found — it may have been pruned."). Poll every 3s while `trace.summary.status` is `queued|running|waiting`; stop on terminal states (clear interval in effect cleanup). Header: back link to `/traces`, name, status badge, `fmtDurationMs`, tokens/cost when non-null, trigger label, red error banner when `error`. Body: `<TraceTimeline spans={trace.spans} />`; empty spans → "No recorded steps for this run."

- [ ] **Step 3: Verify** — `npx tsc --noEmit && npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/traces src/components/traces
git commit -m "feat(traces): trace detail page with span timeline"
```

---

### Task 10: Cross-links from the existing panes

**Files:**
- Modify: `src/app/(app)/g/[scope]/agents/agent-activity-pane.tsx` (expanded run header area)
- Modify: `src/app/(app)/g/[scope]/flows/[id]/activity/page.tsx` (run row)

**Interfaces:**
- Consumes: `/traces/agent/[id]`, `/traces/flow/[id]` (Task 9). Plain `next/link` `Link` — `/traces` is unscoped, so `ScopedLink` must NOT be used (it would prepend the goal lens).

- [ ] **Step 1: Agent pane link**

In the expanded run detail header (near where status/duration render — locate the expanded-row header in `agent-activity-pane.tsx`), add:

```tsx
<Link
  href={`/traces/agent/${run.id}`}
  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
>
  View trace →
</Link>
```

using the run's execution id (the pane's row model — `Activity` — carries it as `id`). Import `Link from 'next/link'` (the file currently aliases `ScopedLink as Link` — import as `import NextLink from 'next/link'` and use `NextLink` to avoid the collision).

- [ ] **Step 2: Flow activity page link**

In the run row (the expandable `TableRow`), add the same pattern with `href={`/traces/flow/${run.id}`}` — same `NextLink` aliasing note (this file also aliases `ScopedLink as Link`).

- [ ] **Step 3: Verify** — `npx tsc --noEmit && npm run lint`; click-through paths exist from Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/g
git commit -m "feat(traces): link agent and flow run surfaces into /traces"
```

---

### Task 11: Full verification

- [ ] **Step 1: Unit suite** — `npm test` → PASS.
- [ ] **Step 2: PG route tests** — throwaway Postgres per the `verify` skill; run the two new `*.pg.test.ts` files with `TEST_DATABASE_URL` → PASS.
- [ ] **Step 3: Build** — `npx next build` → success (new routes `/traces`, `/traces/[kind]/[id]`, `/api/traces*` all compile).
- [ ] **Step 4: Lint/a11y ratchet** — `npm run lint` → no new entries.
- [ ] **Step 5: Commit stragglers** — `git status --short`; commit anything left with an accurate message.
