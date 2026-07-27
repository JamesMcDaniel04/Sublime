# Sublime Goals Tool Plane — Design

**Date:** 2026-07-27
**Status:** Approved for planning

Prerequisite for **sub-project 2** of the "goals leverage AI" arc declared in
`2026-07-26-goal-recovery-plans-design.md`:

1. AI recovery plans — shipped on `feat/goal-recovery-plans`
2. Goal-aligned agent catalogue expansion — **this spec is its prerequisite**; the
   catalogue work itself gets its own spec next
3. New metric adapters — own specs, last

Slicing within the current request ("goal templates should deploy agents, and
integrations need company logos"):

| Slice | Scope | State |
| --- | --- | --- |
| 0 | Company logos on every metric-source surface | Shipped, commit `8021f7e` |
| 1 | `native:sublime-goals` tool plane | **This spec** |
| 2 | Goal-template ↔ agent bundles + goal-page deploy UI | Own spec, next |

Build order rationale: the bundles in slice 2 are only worth deploying if the
agents they deploy can actually see the goal. Without this plane, a "goal-native"
agent knows its target only as text frozen into its instructions at provision
time, and can never observe progress.

## Problem

`SeedTemplate.goalKinds` and `goalTemplatesFor()` already match agents to goals,
but the matching is nearly dead in practice: **6 of ~85 seeds** declare
`goalKinds`, covering only `revenue | arr | mrr | quota | lead_gen`, while **28 of
45** goal templates are `custom_kpi` and 5 are `savings`. For ~33 of 45 goal
templates the matcher returns an empty array.

Fixing the matching is slice 2's job. The deeper problem is that even a correctly
matched agent has no way to perceive the goal it serves. An agent's tool universe
is three planes — per-org MCP connections, native built-ins, and Nango delivery
(`src/features/agents/tool-planes.ts`) — and the native set is a closed list of
`granola | slack | http | email`. Nothing exposes Sublime's own goal state, so
"you are 26% behind pace" is not a sentence any agent can currently produce from
observation.

## Decision summary (from brainstorming)

- **Goal awareness:** live tool access, read **and** write — not a deploy-time
  snapshot templated into instructions.
- **Scoping:** linked goals only, for both read and write. An agent sees exactly
  the goals it is linked to through `GoalContribution` and nothing else. No
  portfolio view, no org-visibility rule.
- **Write scope:** the agent may write a datapoint **only where an AI or human
  already owns the number** — metric sources `manual`, `slack_assisted`,
  `gmail_assisted`. Writes against a system of record (`stripe`, `hubspot`,
  `salesforce`, `postgres`, `google_sheets`, `url`) are refused.
- **No `record_contribution` tool** — see "Rejected: record_contribution".
- **Flows as well as agents** — `GoalContribution.resourceType` already models
  both and scoping by resource costs nothing extra.

## Why a write path is safe here

`MetricDatapoint` carries `@@unique([goalMetricId, bucketKey])` where `bucketKey`
is the UTC day. Re-syncs upsert on that key rather than appending — deliberate,
per the activity-ledger dedupe discipline. The consequence for an agent write is
that **it overwrites the day's row rather than adding to it**. An unrestricted
`log_datapoint` could therefore silently replace a synced Stripe reading with a
model's guess, on the very number the goal is judged by.

The source allowlist removes the hazard structurally rather than by convention: a
metric whose source is `stripe` has no reachable write path at all, so the upsert
can only ever land on a metric that no system of record owns.

`origin` is already `'sync' | 'manual' | 'backfill' | 'assisted'`, and
`'assisted'` exists precisely for AI-extracted readings — it is what the
`slack_assisted` and `gmail_assisted` adapters produce, and the UI already labels
those readings "AI-read". Agent writes reuse `origin: 'assisted'`, so provenance
labeling is inherited with **no UI change and no migration**.

## Shape

A fifth native built-in. No new architecture — the plane pattern is already
load-bearing for four providers.

### Connector descriptor

One entry appended to `BUILTIN_CONNECTORS` in `src/lib/connectors/registry.ts`:

| Field | Value |
| --- | --- |
| `key` | `sublime_goals` |
| `label` | `Goals` |
| `slug` | `sublime` (resolves to the bundled `/sublime-icon.png` via `LOCAL_LOGOS`) |
| `kind` | `builtin` |
| `isWrite` | `true` — the plane can mutate goal data |
| `providerId` | `sublime-goals` |
| `matches` | matches a selected integration string containing `goal` |
| `available` | always `true` — no env or per-org credential |

Connection id resolves through the existing
`formatFlowToolConnectionId('native', 'sublime-goals')` to `native:sublime-goals`.

### Integration module

New `src/lib/integrations/goals.ts`, satisfying the same two-export contract as
`src/lib/integrations/http.ts`:

- `goalsTools(): ToolDefinition[]`
- `class GoalsToolClient { executeTool(serverUrl, name, args) }`

## Tool surface

Four tools. One writes.

### `get_goal`

Returns name, kind, unit, direction, start value, target value, target date,
recurrence, and the current reading. No arguments beyond an optional `goalId`.

### `get_pace`

Returns expected-vs-actual at today, the delta, the run-rate required to finish,
days remaining, and risk level.

Wraps the existing `evaluateGoal(goal, points, now, staleAfterMs)` from
`src/lib/goals/evaluate.ts` rather than recomputing. It is pure and already
tested, and the agent must see exactly the number the dashboard shows — a second
implementation would drift.

### `list_datapoints`

Recent history for the goal's primary metric, newest first, bounded to the last
**90 buckets** so a long-running goal cannot blow the context window (same
concern `MAX_RESPONSE_CHARS` addresses in the HTTP tool).

### `log_datapoint` (write)

Arguments: `value` (required), optional `goalId`, optional `capturedAt`.

`capturedAt` defaults to now. An explicit value is refused when it is in the
future or earlier than the goal's `createdAt` — the two cases that would let a
model fabricate history or pre-date the goal's own existence. Backfill of older
periods stays a human action through the CSV import path.

Refused with a clear, actionable error unless the primary metric's `source` is
one of `manual`, `slack_assisted`, `gmail_assisted`. On success, upserts on
`(goalMetricId, bucketKey)` with `origin: 'assisted'`.

The refusal message names the owning source so the model does not retry blindly:
`"Cannot write this goal's value — it is tracked from Stripe. Report the number in your output instead."`

## Authorization

**Resolved at load time, not at call time.** This is the load-bearing decision of
the design.

`loadNativePlaneGroups` gains an option:

```ts
loadNativePlaneGroups(organizationId, {
  providers,
  resource: { type: 'agent' | 'flow', id: string },
})
```

The goals group materializes only when that resource has at least one
`GoalContribution` row, and `GoalsToolClient` is **constructed with the
already-resolved set of goal ids**. The client holds no organization-wide query
and has no code path that can address a goal outside that set — authorization is
a construction-time property rather than a runtime `if` that a later edit could
bypass or forget.

When the resolved set holds exactly one goal (the common case for a bundled
agent), `goalId` is optional on every tool and defaults to it. A `goalId` outside
the set throws rather than returning empty, so a mis-scoped call is loud.

Call sites to thread the resource through:

- `src/features/agents/execute-agent.ts:275` — has the agent task id
- `src/lib/flows/tool-catalog.ts:52` — has the flow id when validating or running

### Degradation

No linked goal → the group is absent and the agent never sees the tools, matching
how Granola and Slack degrade when unconfigured. Failures inside the loader are
caught and yield no group, never an aborted run.

**Known UX consequence, accepted:** `loadFlowToolCatalog` is also called without
resource context to populate the flow builder's tool picker. The goals connection
will not appear there until the flow is linked to a goal. Revisit only if flow
authors hit it.

## Testing

Pure-unit wherever the logic is pure; no live LLM in any test.

| Test | Asserts |
| --- | --- |
| Source allowlist | `log_datapoint` refuses each of the six system-of-record sources and permits each of the three AI/human-owned ones |
| Plane absence | No `GoalContribution` for the resource → no group returned |
| Scope construction | A client built for goal A throws on an explicit request for goal B |
| Single-goal default | One linked goal → tools resolve with `goalId` omitted |
| Pace agreement | `get_pace` output matches `evaluateGoal` on identical inputs |
| Origin | A successful write lands `origin: 'assisted'` and upserts (does not duplicate) on same-day re-write |
| Registry parity | The descriptor's `providerId` round-trips through `formatFlowToolConnectionId` / the connection-id parser |

## Rejected: `record_contribution`

Considered and dropped. `GoalContribution` stores only the link plus
`estimatedMinutesSavedPerRun`; it has **no `runs` column**, and `goalImpact()` in
`src/lib/goals/impact.ts` derives real run counts through `contributionStats`.
Attribution is therefore already automatic and a tool would be redundant.

Worse, it would be unsound. The schema comment on `estimateEdited` records that
only human edits may feed the calibration median, because provision-time defaults
feeding back into it is self-reinforcement. An agent writing the estimate its own
impact is scored on is exactly that failure, with an extra incentive problem.

## Out of scope

- `GoalNote` / agent annotations — needs a new table and an audit surface
- A distinct `origin: 'agent'` — `'assisted'` already carries the right meaning
  and inherits its UI labeling
- Cross-goal or portfolio reads — foreclosed by the linked-goals-only decision
- Writes to system-of-record metrics, under any flag
- The goal-template ↔ agent bundle mapping and goal-page deploy UI — slice 2
