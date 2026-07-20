# Organization Persona Pipeline

**Date:** 2026-07-20
**Status:** Approved design

## Problem

Connecting an integration today produces two shallow, disconnected signals —
a static department tag derived mechanically from which connector was added
(`departmentsForTools`), and a one-shot connection-scan sample (a few
read-only tool calls, summarized by an LLM, discarded after). Neither
accumulates into a durable picture of "what kind of organization is this,"
and nothing consumes either signal to change template recommendations or
agent runtime behavior. Separately, `src/lib/activity/backfill.ts` already
does real historical windowed pulls (90d/1y/all) but has only one adapter
(Slack — which is a GLUE tool and contributes no department signal at all)
and only runs when an operator manually hits its API route.

This spec closes both gaps together: widen backfill to a second, real
department-anchor source (GitHub), auto-trigger it on connect, and use the
accumulated signal (connection mix + scan profiles + activity volume) to
compute a durable, per-organization **persona** that feeds both template
ranking and agent system prompts. Persona data is Postgres-primary (works
regardless of Neo4j provisioning) and additionally projected into Neo4j when
configured — which it already is in production (Vercel-held credentials),
so this also closes the "Neo4j sits silently dormant" gap by giving the
graph write path a real, logged, actively-exercised producer.

## Scope decisions (from brainstorming)

- **Consumption:** both template/agent recommendation ranking AND runtime
  agent behavior (system-prompt context).
- **Level:** per-organization, not per-user. Matches how department already
  works (org-wide connector mix); per-user is a possible future extension,
  not this pass.
- **Signal shape:** hybrid — the existing fixed `Department` taxonomy stays
  the stable, queryable key (for ranking), refined by real usage weight
  (connection-scan + activity volume) rather than staying purely mechanical;
  an LLM-generated free-form narrative rides alongside it for richer runtime
  context.
- **Storage:** Postgres is the source of truth (`OrganizationPersona`),
  always written regardless of Neo4j/embeddings configuration. A Neo4j
  projection is written in addition whenever `ragEnabled()` — treated as a
  real, actively-used path (prod has credentials), not a someday nice-to-have,
  so failures are logged loudly rather than silently swallowed.
- **Recompute:** event-driven, debounced through one function
  (`recomputeOrgPersona`) safe to call redundantly from multiple triggers.

## Data model

New Prisma model, one row per organization:

```text
organization_personas
  id                 text pk
  organizationId      text unique fk → organizations.id
  departmentWeights  jsonb   -- Record<Department, number>, normalized
  narrative          text?   -- LLM-generated context; null until enough signal exists
  confidence         float?  -- null until a narrative has been generated
  signalsSummary     jsonb   -- {connectedTools: string[], scannedConnections: string[],
                              --  activityEventCounts: Record<string, number>} — audit/debug trail
  computedAt         timestamptz
```

## Backfill widening — GitHub adapter

`src/lib/activity/sources/github.ts`, implementing the existing
`ActivitySource` interface (same contract Slack already implements). Unlike
Slack's bespoke bot-token client, this goes through the Nango proxy — the
same injectable pattern `delivery.ts` already uses for outbound writes
(`proxy({method, endpoint, connectionId, providerConfigKey, params})`,
`NangoProxy` injectable for tests, no real Nango calls in tests). Backfill
window `GET /repos/{owner}/{repo}/issues|pulls|commits`, normalized into
`NormalizedActivity` (action: `opened_issue` / `opened_pr` / `pushed_commit`,
etc.), paginated via the existing `BackfillBatch.nextCursor` contract.
Registered in `src/lib/activity/registry.ts` alongside Slack.

GitHub is a real department anchor (`engineering`) in
`departmentsForTools` — this is the one gap that actually blocks persona
from having anything non-trivial to weight; Slack alone contributes zero
department signal since it's classified as glue.

## Auto-trigger on connect

`src/app/api/nango/status/route.ts` already fire-and-forgets
`scanConnection(...)` the moment it detects a connection went active. Add a
second fire-and-forget call, `startActivityBackfill(...)`, gated on
`getActivitySource(provider) !== null` (only sources with a registered
adapter get auto-triggered — everything else is unaffected). Both calls
independently `.catch(() => undefined)`, matching the existing pattern.

## Persona compute (`src/lib/persona/compute.ts`)

`recomputeOrgPersona(organizationId: string, opts?: { force?: boolean })`:

1. **Debounce.** Read the org's current `computedAt`; skip (no-op) if younger
   than the cooldown window (default 60 min, env-overridable
   `PERSONA_RECOMPUTE_COOLDOWN_MS`, following the existing
   `LLM_MAX_RETRIES`-style override convention) unless `force`.
2. **Gather signals** (all already captured elsewhere — this reads, it
   doesn't newly collect): current connected tools →
   `departmentsForTools` (base weight); recent `captureConnectionProfileKnowledge`
   entries (connection-scan profiles); recent activity-ledger event counts by
   source, mapped through the same anchor-tool → department table, weighted
   more heavily than mere presence since it reflects observed usage, not just
   a connection existing.
3. **Deterministic department weights** — pure function, normalized
   `Record<Department, number>`. Always computed, even with zero signal
   (falls back to `general`).
4. **LLM narrative** — only attempted when signal clears a minimum bar (≥1
   scan profile OR ≥1 non-empty backfill batch observed); otherwise
   `narrative`/`confidence` stay `null`. Uses the now-hardened
   `generateStructured` (streamed, deadline-bound, `effort: 'medium'`) —
   failure here never blocks the deterministic weights from being written.
5. **Persist** — upsert `OrganizationPersona` (Postgres, unconditional).
6. **Project to Neo4j** — only when `ragEnabled()`. Writes a standalone
   org-shared `insight` node with the stable id `persona:<orgId>` (upserts in
   place, mirroring `indexConnectionScan`'s convention). The graph has no
   organization node — every node is already org-scoped by `organizationId` —
   so there is no entity to hang a `HAS_PERSONA` edge on. Every
   attempt logs outcome via `apiLogger` (`.info` on success, `.error` on
   failure with the org id and reason) — replacing the current silent-no-op
   posture other indexers have, since this path is genuinely live in
   production and a failure here should be visible, not swallowed.

Called (fire-and-forget, `.catch()`-guarded) from three places:
`connection-scan.ts` on scan completion, `backfill.ts` on backfill
completion, and indirectly whenever either of those fires from the new
auto-trigger above. The debounce is what makes calling it from three trigger
points safe rather than wasteful.

## Consumption

- **Template/agent ranking** — `src/lib/intelligence/suggest-workflows.ts`
  (and any other relevance-sorting call site using `departmentsForTools`
  today) gains a boost term: overlap between a template's tagged department(s)
  and the org's persona `departmentWeights`, instead of (or alongside) the
  current purely-mechanical department match.
- **Agent runtime behavior** — `src/features/agents/system-prompt.ts`
  (`buildAgentSystemPrompt`) appends the persona `narrative` as ambient org
  context, when present, so agents calibrate tone/defaults without per-agent
  configuration. Absent narrative (new/low-signal org) → no line added, not a
  placeholder.

## Error handling

- Debounce guards against recompute storms from the three trigger points.
- LLM narrative failure degrades to deterministic-weights-only; the function
  never throws out of the fire-and-forget call sites.
- Neo4j write failure is logged loudly but never blocks the Postgres write
  or the calling trigger — same fire-and-forget `.catch()` shape used
  throughout this pipeline already (`indexExecution`, `recordToolCallEvents`).
- Zero-signal orgs get `general`/unweighted persona, never a fabricated
  narrative.

## Testing

- GitHub adapter: injectable `NangoProxy`, no real Nango/GitHub calls — same
  approach as `delivery.ts`'s existing tests.
- Deterministic department-weighting: pure function, unit-tested over
  synthetic signal inputs (connections only, connections + scan profiles,
  connections + activity volume, zero signal → `general`).
- `recomputeOrgPersona`: unit-tested with fake signals and an injectable
  `generateStructured`-shaped dependency (the same `deps.generate` override
  pattern already used in `reflection.ts` / `suggest-workflows.ts`), plus one
  throwaway-Postgres integration test proving the debounce actually skips a
  too-recent recompute.
- Neo4j projection: tested against the existing `MemoryGraphStore` fallback
  (no real Neo4j needed locally) to verify node/relationship shape.
- Auto-trigger wiring: `/api/nango/status` has no existing test coverage —
  add a route test asserting `startActivityBackfill` fires for a source with
  a registered adapter and does NOT fire for one without.
