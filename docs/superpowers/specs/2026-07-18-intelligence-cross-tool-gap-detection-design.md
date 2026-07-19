# Intelligence Phase 1: Cross-Tool Correlation + Capability Gap Detection

**Date:** 2026-07-18
**Status:** Approved design, pending implementation plan
**Scope:** Phase 1 of the intelligence-layer hardening. Cross-user collaborative
signal, platform-wide anonymized archetypes, and deeper outcome-learning weights
are explicitly deferred (see "Future phases").

## Problem

The behavioral-intelligence pipeline (spec 2026-07-11) learns from what a user
*does* — sequence, temporal, friction, and intent patterns mined from
`user_events` — but it is blind in two ways:

1. **No cross-tool signal.** Connection scans profile each integration in
   isolation. Nothing observes that a user works Asana and GitHub together, so
   nothing can suggest a workflow bridging them.
2. **No gap detection.** The system only suggests from observed behavior, never
   from its absence: dormant connections, unused capabilities, manual routines
   that a connected tool's existing action could absorb.

The surfacing model stays deliberately quiet: **one open suggestion per user,
weekly cadence**. This phase makes that one suggestion smarter; it does not add
volume.

## Decision summary

- Surfacing: unchanged ("keep quiet, better quality").
- Approach: graph-first (Approach A) with one refinement — deterministic
  counting runs in Postgres; the graph holds topology and provenance, never
  counts Postgres can't recompute.
- Suggestion kinds stay `new_flow` | `enhancement` — zero UI changes.

## Architecture

Postgres remains the system of record and the computation substrate
(`user_events`, `audit_events.tool`, `activity_events`). Neo4j (via the
`GraphRagStore` abstraction) is the relationship substrate: tool topology,
correlation insights, and provenance edges that retrieval and later phases
traverse. Every graph feature must work identically on `MemoryGraphStore`
(the interface exposes only `search`/`expand`), which is why miners are not
written in Cypher — Cypher miners would fork logic between stores and break
local dev. The graph is always rebuildable from the ledger.

### 1. Graph schema extensions (`src/lib/rag/store.ts`)

New `NodeType`s, both org-shared (they describe tools, not people):

- `tool` — one node per connected integration provider. Node id scheme:
  `tool:nango:<provider>`, `tool:mcp:<connectionId>`, `tool:native:<provider>`
  (added to `nodeIds` in `src/lib/rag/indexer.ts`). Created on connection add
  and refreshed during catalog loads / connection-scan ticks.
- `capability` — one node per action a tool exposes
  (`capability:<provider>:<toolName>`), sourced from the existing flow tool
  catalog (`src/lib/flows/tool-catalog.ts`), carrying the `risk` label
  (`read` | `write` | `destructive`) as a prop.

New `EdgeRelation`s:

- `provides` — tool → capability (the catalog, materialized).
- `used` — activity → tool (this user action touched this tool).
- `used_with` — insight(tool_correlation) → tool (which tools a mined
  correlation binds).

Mined patterns of the new kinds are projected as `insight` nodes with the
existing `evidence` edges (insight → activity), matching the provenance design
already anticipated by the `evidence`/`based_on` relations.

### 2. Signal capture: one new event kind

Add `tool_call` to `USER_EVENT_KINDS` (`src/lib/behavior/record-event.ts`),
recorded at the tool-execution seam — agent executions and flow run steps —
**deduped to one event per (execution, provider)** so a chatty agent does not
flood the ledger. Shape:

- `resourceType: 'integration'`, `resourceId: <provider key>`
- `context: { provider, toolNames: string[], executionId }` — references only,
  per the existing privacy contract (never arguments or results).

This is the missing signal: today the ledger knows a user ran an agent but not
which integrations the run touched.

### 3. Deterministic miners (new file `src/lib/behavior/mine-correlations.ts`)

Same contract as `mine-patterns.ts`: pure functions over the sorted ledger,
computed counts, evidence event ids, no LLM. Two new `PatternCandidate` kinds
(the `PatternCandidate.kind` union widens to include them):

**`tool_correlation`**
- Sessionize a user's events with a 30-minute inactivity gap.
- Count sessions containing `tool_call` events for ≥2 distinct providers.
- Eligibility threshold: ≥5 co-occurring sessions across ≥3 distinct days.
- Slug: `toolcorr:<providerA>+<providerB>` (providers sorted alphabetically).
- Summary example: "Uses Asana and GitHub together — 14 of the last 20 work
  sessions."

**`capability_gap`** — three deterministic rules:
1. *Dormant connection*: `connection_added` ≥30 days ago and zero `tool_call`
   events for that provider ever. Slug: `gap:dormant:<provider>`.
2. *Manual cadence*: an existing `temporal` pattern targets a flow whose
   trigger is `manual` — the schedule trigger exists and is unused.
   Slug: `gap:schedule:<flowId>`.
3. *Unused bridging capability*: a `tool_correlation` or `friction` pattern
   involves provider X, and the catalog shows X has capabilities never
   appearing in that user's `tool_call` events (matching is deterministic:
   same provider, capability name absent from the ledger).
   Slug: `gap:capability:<provider>:<toolName>`.

### 4. Projection & eligibility

- `src/lib/behavior/index-user-event.ts`: `tool_call` events additionally emit
  a `used` edge from the activity node to the tool node.
- Tool + capability nodes projected on connection add and refreshed by the
  existing connection-scan tick (`src/lib/intelligence/connection-scan.ts`).
- Eligible new-kind patterns get insight nodes with `evidence` edges
  (→ activity nodes) and `used_with` edges (→ tool nodes) via the existing
  `commitGraph` path in `infer-user-patterns.ts`.
- `src/lib/behavior/eligibility.ts` gains per-kind thresholds:
  `tool_correlation` ≥5 sessions; `capability_gap` dormancy ≥30 days or
  cadence ≥3 occurrences.

### 5. Synthesis: same quiet pipeline, smarter inputs

`src/lib/intelligence/suggest-user-workflows.ts` changes only in its inputs:

- New pattern kinds flow into the existing prompt list (they are ordinary
  `user_patterns` rows).
- The prompt gains an "Unused capabilities of your connected tools" block
  rendered deterministically from the catalog (names + risk only, no schemas).
- The system prompt states the model may connect a mined pattern to an unused
  capability, but `sourcePatternSlugs` must still cite mined slugs. The
  existing `parseUserSuggestions` validator already rejects uncited
  suggestions — the hallucination guard needs no new code.
- Suggestion kinds stay `new_flow` | `enhancement`; a gap manifests as either.

Untouched invariants (load-bearing): one open suggestion per user, weekly
atomic claim on `users.metadata.lastBehaviorSynthesisAt`, monthly token budget
gate, drafts only, evidence cited from gate-validated patterns only.

## Error handling

- `recordUserEvent` is already fire-and-forget; `tool_call` capture inherits
  that (a capture failure never breaks the tool call it records).
- Graph projection stays best-effort with `indexedAt` sweep recovery, as today.
- Miners are pure; a malformed ledger row is skipped, never thrown on.
- Catalog load failures degrade to an empty unused-capability block (the
  catalog already never throws for one bad plane).

## Testing

- Sessionizer and both miners: pure-function unit tests in the existing miner
  test style (fixture ledgers → expected candidates, thresholds at boundaries).
- Gap rules: one test per rule, plus a no-false-positive test (active
  connection, scheduled flow, used capability → no gaps).
- Projection: assert node/edge parts against `MemoryGraphStore`.
- Synthesis: prompt-assembly test that the unused-capability block renders and
  that uncited suggestions are still rejected.
- End-to-end: `verify` skill route-smoke protocol (throwaway Postgres, real
  route handlers, seeded auth).

## Future phases (deferred, recorded for architectural continuity)

1. **Org-level collaborative signal** — "teammates with your tool mix automate
   X"; traverses the tool nodes this phase creates.
2. **Platform-wide anonymized archetypes** — cross-org patterns keyed on tool
   mix + role archetype; requires k-anonymity thresholds and a review of what
   may leave an org boundary (nothing entity-level ever does).
3. **Outcome-learning weights** — per-user adoption history
   (`suggestionOutcomeLabel`) weighting future pattern eligibility, not just
   the synthesis prompt.
4. **Cypher-native miners** — only if/when Neo4j becomes mandatory and the
   in-memory fallback is retired.
