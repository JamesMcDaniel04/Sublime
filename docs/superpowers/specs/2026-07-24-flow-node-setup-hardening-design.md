# Flow Node Setup Hardening — Design

**Date:** 2026-07-24
**Status:** Approved (design)
**Goal:** Make configuring a flow node feel like n8n rather than a form on a canvas card — see your data while you map it, test one node at a time without firing the rest of the flow, and never be told a credential works when nobody has checked.

## Problem

Three complaints, one root cause: the builder gives no feedback until you run the
whole flow.

1. **You configure blind.** Node params live in an inline expandable card on the
   canvas (`step-card.tsx`, 2766 lines). There is no room beside them for the
   upstream data you are mapping *from* or the output you are mapping *to*, so
   `{{step.n2.items.0.name}}` is guesswork until a full run proves it wrong.
2. **The feedback loop is the whole flow.** Partial-run machinery exists
   (`startNodeId` + `mockOutputs`, wired through `interpret.ts`) but is exposed
   only as a checkbox plus a hand-typed JSON textarea in the Test panel, and it
   runs the selected node *and everything downstream* — so using it to check one
   step fires every write action after it.
3. **Credentials lie.** A connection whose token expired still appears healthy in
   the tool node's picker. `loadFlowToolCatalog` already carries `toolsError`
   ("token expired, server unreachable, not yet authorized") and the tool node's
   `<select>` ignores it. `McpConnection.lastVerifiedAt` is written only by the
   OAuth callback — the pre-save **Test connection** button proves the credential
   works and discards the proof.

## Confirmed decisions (user)

- **Config surface: NDV overlay (n8n-style).** A full-width overlay with
  Input | Parameters | Output. The canvas card becomes **summary-only** — one
  config surface, so two editors can't drift.
- **Credential validation: verified-state model.** Every credential carries
  `verified | stale | failed | unverified` + a timestamp, written by tests *and*
  by real runs, surfaced in the NDV picker, the checker panel, and the publish
  gate. Chosen over a hard save-time gate because a gate cannot express drift
  (a credential valid at save time expires later) and cannot cover OAuth
  authorization-code flows, where the callback *is* the test.
- **Per-node test: one node, resolved input.** "Test step" executes exactly the
  selected node — nothing downstream. Input resolves pinned data → last run's
  output → offer to run the missing ancestors, with a write-risk warning naming
  the write actions first. "Run from here" survives as an explicit secondary
  action behind a confirm.
- **Credentials: the vault is the only path.** The inline `http.data.auth`
  option shipped in `33c5d10` contradicts the approved credential-vault design
  and is retired (see Prerequisite).

## Landed already

**`6c822f7` — `fix(flows): stop exporting inline HTTP auth credentials`.** Found
while scoping this work. `http.data.auth` stores the credential inline in the
graph; `redactHttpStepInput` redacted it but `sanitizeNode` in the export path
did not, so all five export targets shipped the plaintext token while the
export's own `requirements` text claimed credentials had been stripped — and
export needs only read access, so an org-shared flow handed its HTTP credentials
to every reader. Both sinks now consume one `redactHttpAuthOption` definition.
Regression test asserts across all five targets.

That fix closes the leak; it does not make inline graph secrets a good idea. The
Prerequisite below removes them.

## Program shape

Sequenced. Each phase is independently shippable and independently valuable.

| # | Phase | Depends on |
|---|-------|-----------|
| P | Credential vault + inline-auth retirement | — |
| 0 | Split `step-card.tsx` | — |
| 1 | NDV shell | 0 |
| 2 | Per-node test | 1 |
| 3 | Credential verification state | P, 1 |
| 4 | Form quality | 0, 1 |

Phase P and Phase 0 are independent and can run in parallel. Phase 3 is the only
phase that needs the vault.

---

## Prerequisite — Credential vault + inline-auth retirement

The [2026-07-21 credential-vault plan](../plans/2026-07-21-credential-vault-http-parity.md)
is already written and approved, with **zero tasks checked**. Execute it as
written. It is not restated here.

That plan predates `33c5d10` and therefore does not cover retiring the inline
auth that shipped after it. This spec adds that delta:

### Static values migrate; token expressions stay

`http.data.auth` values may contain `{{tokens}}` (per `graph.ts`). A value that
is *entirely* a token expression is not a secret — it is a reference resolved at
run time, and the Phase-1 vault stores only static secrets. So the split is:

- **A literal value** (`token: "sk_live_abc"`) is a secret → migrate to a
  `Credential` row, rewrite the node to `credentialId`.
- **A fully-tokenized value** (`token: "{{trigger.input.apiKey}}"`) is not a
  secret → leave it inline.

After migration, `validate.ts` enforces the invariant: **inline `auth` may carry
token expressions only, never literals.** A literal is a validation error with a
"move this to a saved credential" action. That keeps the dynamic use case alive
until the vault's Phase 2 runtime-auth node lands, while making "plaintext
secret in the graph" unrepresentable going forward.

### Data migration

A one-time script, run once and kept for the record:

- **`Flow.graph` and `Flow.publishedGraph`** — live editable configs. Create one
  `Credential` per distinct literal secret (deduped by value within an org, named
  after the node's label + host), rewrite the node to `credentialId`, drop the
  literal.
- **`FlowVersion` snapshots** — historical. **Redact** the literals in place
  rather than migrating; a version restore already prompts for re-entry, and
  keeping plaintext in immutable history is the thing we are removing.
- **`FlowRun.graphSnapshot`** — redact for runs in a terminal state
  (`succeeded | failed | stopped`). **Leave `waiting` runs intact**: their
  snapshot is pinned for resume, and redacting it would break an in-flight paused
  run's auth. The script logs the count of skipped `waiting` runs; a follow-up
  sweep re-runs after they settle or are reaped.

The script is idempotent — re-running finds nothing left to migrate.

---

## Phase 0 — Split `step-card.tsx` (pure refactor, zero behaviour change)

`step-card.tsx` holds the card chrome *and* every node's param body behind a
`renderNodeBody` switch. That switch is currently the only thing that knows
which fields a node type has.

```text
src/components/flows/nodes/
  registry.ts            NODE_BODIES: Record<FlowNode['type'], NodeBodyModule>
  field-primitives.tsx   labelClass, controlClass, InlineKeyValue, parseKeyValueRows…
  tool-body.tsx  http-body.tsx  agent-body.tsx  trigger-body.tsx  …(one per type)
step-card.tsx            card chrome only: header, issues popover, token wiring, footer
```

Each module exports `{ Body, defaultEditorKey, requiredFields }`.
`DEFAULT_EDITOR_KEYS` moves onto the modules that own those keys.

**This lands first and alone.** The NDV must host the *same* param bodies as the
card; without the split it either duplicates them or imports a monolith. Turning
the switch into a data registry is also what makes later phases cheap:
`requiredFields` drives Phase 4's validation highlighting once instead of twenty
times, and the NDV becomes a second *consumer* rather than a second
*implementation*.

Acceptance: no behaviour change. The existing `step-card` and `dag-canvas` tests
pass untouched.

## Phase 1 — NDV shell

```text
src/components/flows/ndv/
  node-detail-view.tsx   overlay + 3-pane layout + keyboard handling
  input-pane.tsx         upstream datatree, drag source
  params-pane.tsx        hosts the Phase-0 body module + connection health chip
  output-pane.tsx        last-run output for this node + pin control
```

- **Input pane** reuses `buildDataTree` unchanged — it already accepts
  `lastOutputs`, and `page.tsx` already builds them from `FlowRunStep.output`.
  Adds HTML5 drag-to-param on top of today's click-to-insert.
- **Output pane** renders this node's last-run output and owns the pin control.
- **State**: `ndvNodeId` in `page.tsx`, synced to `?node=<id>` so an NDV is
  linkable and survives a refresh. Pane widths reuse `ResizablePanel` with
  `flow.ndv.*` storage keys.
- **Opening**: double-click a card, Enter on a selected card, or the card's
  Open affordance. Escape closes; the card keeps `collapsedAffordance` as its
  summary.
- The canvas card no longer renders param bodies at all.

## Phase 2 — Per-node test

### Executor bound

`interpret.ts` gains `opts.onlyNodeId`. At the reachability flood-fill, when it
is set, `reachable` becomes `new Set([onlyNodeId])` instead of walking
`outEdges`. Everything downstream is then *structurally* unreachable, so retry,
timeout, token resolution, budget caps, and audit all keep working untouched —
no parallel executor. Ancestor data arrives through the existing `completed`
seeding that `mockOutputs` already uses.

### Route

`POST /api/flows/[id]/test-node`, body `{ nodeId, input, mockOutputs }`.
Separate from `/execute` so it can skip `recordUserEvent('flow_run_manual')` and
tag its run `trigger: { type: 'node_test', nodeId }` — `FlowRun.trigger` is
already `Json`, so no migration. The runs list filters that tag out by default;
the inspector can still open one.

### Input resolution

New pure module `src/lib/flows/node-test-input.ts`:

```ts
resolveNodeTestInput({ nodeId, graph, pins, lastOutputs })
  → { mockOutputs, missing: NodeRef[], riskyMissing: NodeRef[] }
```

Order: pinned → last-run output → report as `missing`. `riskyMissing` filters
`missing` by the catalog's existing `risk` classification (`write | destructive`)
so the confirm dialog can name the write actions before running any ancestor.

### Pinning

New `FlowNodePin` table keyed `(flowId, nodeId, userId)` — needs a migration.
Deliberately **not** stored in the graph: pins are dev-time fixtures and must
never reach `publishedGraph` or `/export`.

### Run-from-here

Today's `startNodeId` behaviour survives as an explicit secondary action, behind
a confirm that lists the downstream write actions it will fire.

## Phase 3 — Credential verification state

One uniform table rather than per-plane schema churn, keyed by the exact id the
builder already uses (`<raw-cuid>` | `native:slack` | `nango:gmail` |
`credential:<id>`):

```prisma
model ConnectionVerification {
  organizationId String   @db.Uuid
  connectionId   String
  state          String   // verified | failed
  checkedAt      DateTime
  error          String?  @db.Text
  @@id([organizationId, connectionId])
}
```

`verificationState(row, now)` is pure and returns
`verified | stale | failed | unverified`; stale after a `VERIFY_STALE_MS`
constant (7 days).

**Four writers:**

1. The existing `/api/mcp-connections/test` route — persists the proof it
   currently discards, on both success and failure.
2. The OAuth callback — already writes `lastVerifiedAt`; also writes here.
3. **Every flow run.** `toolsError` on a plane group *is* a credential failure →
   `failed`. A successful tool call → `verified`. This is the writer that catches
   drift, and it costs nothing extra.
4. `POST /api/connections/verify` — on-demand re-check from the NDV.

**Surfacing:** `loadFlowToolCatalog` returns `verification` per connection →
health chip in the NDV picker; `validate.ts` gains `CONNECTION_FAILED` (error)
and `CONNECTION_UNVERIFIED` (warning), so the checker panel and the publish gate
both pick it up through the existing `validateFlowGraph` call sites with no new
wiring.

### Honest limitation

A generic vault credential (Bearer, Basic, header key) **cannot be validated
without a target** — there is no endpoint to probe. So for `credential:<id>`
rows:

- Verification is earned at runtime (writer 3) — a real request that succeeded.
- The NDV offers an optional explicit probe where the user supplies a test URL,
  which then writes state like any other check.
- Until either happens the credential reads **unverified**, and the UI says
  "not yet used successfully" rather than implying a check was performed and
  passed. Not-yet-checked must never render as healthy — that is the entire
  point of this phase.

## Phase 4 — Form quality

- **Live resolved-value preview** under every token field, evaluated against the
  datatree's sample values, truncated. This is what makes `{{…}}` mapping
  self-evidencing.
- **Required-field enforcement** across all bodies, driven by the registry's
  `requiredFields` instead of per-body `showErrors` checks.
- **Searchable combobox** connection/action pickers replacing the bare
  `<select>`s, reusing `flow-picker.tsx` patterns — the tool catalog can carry
  hundreds of actions.
- **Field descriptions** surfaced from `inputSchema.description` in
  `tool-args-editor.tsx`.

---

## Error handling

- **Node test with unresolvable input** — the NDV states which ancestors have no
  data and offers to run them; it never silently substitutes `{}` and reports a
  green result on fabricated input.
- **Node test on a container node** (`loop`, `parallel`, `repeatUntil`,
  `errorShield`) — running one container in isolation has no coherent meaning,
  since its behaviour *is* the execution of its body. The Test step button is
  disabled with a reason; the container's *body* steps remain individually
  testable.
- **Failed credential at test time** — surfaced as the step's real error plus the
  verification state write, so one failed test updates every place that
  connection appears.
- **Migration ambiguity** — an inline auth value that is *partly* literal and
  partly token (`"Bearer {{x}}"`) is treated as a literal (the safe reading) and
  migrated, with the token preserved inside the vaulted value.

## Testing

- **Unit:** `resolveNodeTestInput` (pin → last-run → missing ordering; risky
  filtering); `verificationState` boundaries (fresh / stale edge / failed /
  absent); the registry's `requiredFields` covering every node type in
  `FlowNode['type']` (a total-union test, so a new node type can't silently ship
  without required-field metadata); the inline-auth literal-vs-token classifier.
- **Interpreter:** `onlyNodeId` executes exactly one node — with an explicit
  write-safety case asserting a downstream `destructive` tool never runs.
- **Route-smoke** (throwaway Postgres, repo `verify` skill): `/test-node`
  (including cross-org id → 404, container node → 400) and
  `/api/connections/verify`.
- **Migration:** a fixture graph carrying literal, tokenized, and mixed auth
  values migrates correctly; re-running is a no-op; `waiting` runs' snapshots are
  left intact and counted.
- **Regression:** the export-redaction test from `6c822f7` extends to assert no
  vaulted secret appears in any export target.

## Out of scope

- **The vault's Phase 2 runtime-auth node** (OAuth2 client-credentials and
  authorization-code, auto-refresh) — that plan owns it.
- **Formula/expression language.** Live *preview* of `{{token}}` values is in
  Phase 4; a function grammar (`concat`, `formatDate`, …) remains the separate
  large bet in the parity report.
- **Mocked step outputs as a saved flow property** ("static results"). Pinning
  here is per-user dev-time data, not a flow-level test fixture.
- **Minimap / fit-to-content**, multi-select, polling triggers — unrelated
  parity items.
