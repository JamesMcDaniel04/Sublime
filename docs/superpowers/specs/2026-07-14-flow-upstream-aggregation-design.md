# Flow Nodes: Automatic Upstream Aggregation + API Capture Hardening — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming session with owner)

## Problem

Flow nodes complete independently: an agent node only receives the data a user
**manually** hand-wires into its input/prompt with `{{…}}` tokens (default is
literally `{{trigger.input}}`). Drop several API/HTTP nodes before an agent and
forget to reference each one's output, and the agent silently ignores all of it.
The engine captures the data — it just never reaches the agent automatically —
so flows read as "nodes firing and completing independently" rather than working
together toward a larger goal.

Key scenario the owner wants at 100% parity: **API nodes run before an agent,
each pulls + captures data from its endpoint, the outputs of all prior nodes are
aggregated, and that aggregate feeds the agent the context it needs** — with no
manual per-field wiring.

Additionally (reliability): when an API/tool node fails with `onError:
'continue'`, it currently records **no** output at all, so downstream refs and
any aggregate see nothing instead of a recorded failure.

## What already works (verified — do NOT rebuild)

- **API nodes reliably call + capture.** `prepareHttpRequest` / `responseOutput`
  (`src/features/flows/http.ts`) plus the executor's action runner
  (`src/features/flows/execute-flow.ts` ~708-783) do SSRF-guarded fetches with
  timeout, retries+backoff, redirects, pagination, and per-request connection
  auth injection, capturing `{ ok, status, statusText, url, headers, body
  (parsed JSON), bodyText }`.
- **Every node's output is retained + referenceable.** The interpreter keeps
  `ctx.step[nodeId].output` for every completed step
  (`src/features/flows/context.ts` / `interpret.ts`), referenceable as
  `{{Node Label.output.field}}` / `{{step.<id>.output}}`, resolved by
  `resolveTemplate`.

The gap is purely: **no automatic aggregation of upstream outputs into agents**,
plus the one capture edge case above.

## Goals

1. An agent placed after data-bearing nodes **automatically** receives their
   aggregated captured outputs as context — zero manual wiring.
2. Works for **new and existing** agents without migrating saved graphs.
3. Bounded: a huge API response cannot blow the agent's context window.
4. Every API/tool node always leaves a record in the run context, success or
   handled-failure.

## Non-goals

- No change to the existing token syntax; `{{Node.output.field}}` stays.
- No aggregation of control-node state or secrets (auth headers already never
  enter the context; keep it that way).
- Not strict graph-ancestor precision in v1 — scope is "data-bearing steps
  executed so far in the run" (simple, deterministic, covers the
  API-nodes-then-agent case). Ancestor-path filtering is a future refinement.

## Design

### 1. Aggregation engine — the `{{upstream}}` context root

- Add `ctx.upstream` to `FlowContext` and support `{{upstream}}` in `readPath`
  (`src/features/flows/context.ts`). It resolves to a labeled bundle of the
  **data-bearing** nodes that have executed so far, keyed by builder label:
  ```json
  { "Fetch CRM": { "ok": true, "status": 200, "body": {…} },
    "Enrich Lead": { "ok": true, "body": {…} } }
  ```
- **Data-bearing node types (included):** `http`, `tool`, `data`, `transform`,
  `agent`, `subflow`. **Excluded:** `trigger`, `condition`, `switch`, `router`,
  `loop`, `parallel`, `stop`, `filter`, `wait`, `humanReview`, `respondWebhook`,
  `input`, `variable`, `errorShield` (no meaningful payload; variables have
  their own `{{var.*}}` channel).
- Maintained **incrementally** by the interpreter (it has node types via
  `byId`; `context.ts` does not): when a data-bearing node writes
  `ctx.step[id]`, it also records the entry under `ctx.upstream` keyed by the
  node's label (skipping `excludeFromContext` sources). `{{upstream}}` resolves
  to `ctx.upstream` **serialized with the size cap applied** (a shared
  `serializeUpstream(ctx.upstream, { maxChars })` helper), so both the token and
  the agent auto-append use one capped serialization. O(1) per step — no
  per-node recomputation.
- **Size cap** (default 20,000 chars over the serialized bundle): oversized
  single outputs are truncated with a `"…[truncated]"` marker; the bundle never
  exceeds the cap. Prevents context blow-up.
- Label collisions (two nodes with the same label) disambiguate with a short id
  suffix so no output is silently dropped.

### 2. Automatic injection into agents (the default behavior)

In the interpreter's agent execution path (`interpret.ts` ~692):
- Compute `ctx.upstream` (§1) before running the agent.
- Build the effective input = the user's resolved input, and **append**
  `\n\nUpstream data:\n{{upstream}}` (resolved) when the node uses its **DEFAULT
  input** (blank or `{{trigger.input}}` — the common "saved agent placed after
  some API steps" shape, where the agent's instructions live in its persona and
  the node input is just the trigger passthrough). This is the runtime default
  and needs zero configuration.
- A **hand-customized** input is left exactly as authored — the user chose what
  to pass. Such an agent still gets the aggregate on demand via
  `includeUpstream === true` (explicit opt-in) or by referencing `{{upstream}}`
  itself.
- Never appended when: the node opts out (`includeUpstream === false`), or the
  authored input/prompt already references `{{upstream}}` (respect placement, no
  duplication).
- This is a **runtime** behavior — no stored-graph mutation, no migration — so
  existing default-input agents gain the behavior immediately while customized
  flows are untouched.

  Semantics table (`includeUpstream`): `false` → never; `true` → always (even
  customized input); absent (default) → only when the node input is the default.

**Node data additions (`src/lib/flows/graph.ts`):**
- `agentNode.data.includeUpstream?: boolean` (default true when absent).
- Source nodes (`http`, `tool`, `data`, `transform`) gain
  `excludeFromContext?: boolean` — a per-node "don't include my output in the
  aggregate" flag for noisy sources. `aggregateUpstream` skips those ids.

### 3. Capture hardening (reliability half)

In `interpret.ts` at the `tool`/`http` error path (~652): when `onError ===
'continue'` and the action failed, record a **structured failure** into the
context before continuing:

```ts
ctx.step[node.id] = { output: { ok: false, error: res.error } }
```

The run-timeline emit is **unchanged** — the step still reports `failed` (line
651), which is accurate; we only ADD the context entry that was previously
missing. Downstream refs and the aggregate now see `{ ok: false, error }`, so an
agent can reason about partial data rather than getting a silent blank.

### 4. Builder UX (`src/components/flows/step-card.tsx`, token picker)

- Agent card: a small **"Auto-receives upstream data"** affordance and an
  `Include upstream context` toggle bound to `includeUpstream`.
- `{{upstream}}` offered as an insertable chip in the token picker for explicit
  placement.
- Source nodes: an **"Exclude from agent context"** control bound to
  `excludeFromContext`.
- These are transparency + control surfaces; the runtime default already does
  the right thing without them.

### 5. Testing

- **Aggregation (unit, pure helper):** `aggregateUpstream` returns the labeled
  bundle of executed data-bearing steps; excludes control nodes and
  `excludeFromContext` sources; honors the size cap + truncation marker;
  disambiguates label collisions.
- **`{{upstream}}` resolution (context):** resolves `ctx.upstream` whole.
- **Agent auto-append (interpreter):** agent effective input gains the upstream
  section unless `{{upstream}}` already referenced or `includeUpstream === false`.
- **Capture hardening (interpreter):** failed-and-continued `http` node writes
  `{ ok:false, error }` to `ctx.step`.
- **End-to-end:** `API1 → API2 → Agent` — the agent's resolved input contains
  both API bodies with zero manual wiring.

## Rollout / risk

- All changes are additive and runtime-scoped; no graph migration. Existing
  flows keep working; agents simply start receiving upstream context (opt-out
  available). The size cap bounds token cost.
- The capture-hardening change only affects the already-failing
  `onError:'continue'` path — it can only add information, never remove it.
