# Intelligence Phase 3: Platform-Wide Anonymized Archetypes

**Date:** 2026-07-18
**Status:** Approved design (phase 3; follows the phase 1 cross-tool and
phase 2 peer-practices specs)
**Deferred:** outcome-learning weights (phase 4).

## Problem

Phases 1–2 learn inside one org. A new or small org gets no signal about what
working automation looks like: "organizations that use Asana + Slack almost
always run a scheduled digest between them" is knowledge the platform has and
no single tenant can see.

## Privacy model (load-bearing, k-anonymous by construction)

What crosses the org boundary is ONLY the **automation shape**:
`(providers sorted, triggerType)` — both drawn from platform vocabulary
(runtime provider strings, trigger kinds), never user content. No flow names,
descriptions, entity names, org ids, or user ids are ever aggregated or
stored.

- Aggregates live in a new GLOBAL table `platform_archetypes` with **no
  organizationId column by design**.
- A row is written only when `orgCount >= MIN_ARCHETYPE_ORGS` (default 5,
  env `PLATFORM_ARCHETYPE_MIN_ORGS`) distinct orgs share the shape; rows
  falling below the threshold are deleted on the next sweep. The table is
  k-anonymous at rest, not just at read time.
- Suggestion summaries cite counts ("N other organizations"), never names.

## Data model (`prisma/schema.prisma` + migration)

```
platform_archetypes
  id          text pk
  signature   text unique   -- "<providers sorted, '+'-joined>:<triggerType>"
  providers   jsonb         -- string[] (runtime provider vocabulary)
  triggerType text          -- manual | schedule | signal
  orgCount    int           -- distinct orgs running this shape (>= K always)
  flowCount   int           -- total qualifying flows across those orgs
  createdAt / updatedAt
```

## Aggregation (`src/lib/intelligence/aggregate-archetypes.ts`)

Daily global sweep (cron dispatch, 04:00 UTC window; systemPrisma by design):

1. Per org (capped 500): published flows (`status='ACTIVE'` or
   `publishedGraph != null`) with `>= 3` succeeded runs in 30 days, providers
   resolved from the org's `tool_call` ledger via `executionId` (the phase 2
   technique — same vocabulary, no backfill).
2. Shape = sorted provider set + normalized trigger type; one org contributes
   each shape at most once to `orgCount`.
3. Upsert shapes with `orgCount >= K`; delete stored rows that no longer
   qualify. Pure helpers (`computeOrgShapes`, `aggregateShapes`) carry the
   logic so it is testable without a database.

## Miner (`src/lib/behavior/mine-archetypes.ts`)

New pattern kind `archetype_gap`, pure and deterministic. Inputs: the k-anon
archetype rows, the org's own shape signatures, the org's touched providers,
and U's ledger. A candidate exists when ALL hold:

1. `archetype.providers ⊆ org's touched providers` (the org has these tools).
2. `signature ∉ org's own shapes` (the org lacks this automation).
3. U personally touched `>= 1` of the archetype's providers — evidence is U's
   own `tool_call` events on them (evidence contract unchanged).

Ranked by `orgCount` desc, capped at 3 candidates per run. Slug:
`archetype:<signature>`. Summary: `<orgCount> other organizations that use
<providers> run <triggerType>-triggered automations across them — your
workspace has none`.

## Gate, graph, synthesis

- Eligibility: `archetype_gap` gates like `capability_gap`/`peer_practice`
  (occurrence/span bypassed; staleness + learning period apply; `lastSeenAt =
  now` at mining so a closed gap decays out).
- Graph: archetype insights project through `writeUserInference`, plus
  `used_with` edges to the tool nodes named in the signature.
- Synthesis: one system-prompt line — archetype patterns describe what many
  OTHER organizations automate; suggest conservatively and never imply
  knowledge of any specific org.

## Testing

- Aggregation helpers: shape computation, k-anonymity filter (below-K shapes
  never surface), org contributes a shape once.
- Miner: qualifying case, each rule's rejection, orgCount ranking + cap,
  evidence is U's events only.
- Eligibility: archetype_gap bypass + decay.
