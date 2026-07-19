# Intelligence Phase 2: Org-Level Collaborative Signal (Peer Practices)

**Date:** 2026-07-18
**Status:** Approved design (phase 2 of the intelligence hardening; follows
2026-07-18-intelligence-cross-tool-gap-detection-design.md)
**Deferred:** platform-wide anonymized archetypes (phase 3), outcome-learning
weights (phase 4).

## Problem

Phase 1 made the weekly suggestion smarter about one user's own behavior. It
still cannot say "a teammate already solved this": when someone in the org runs
a proven, org-shared automation over tools user U also works with, U's
suggestion engine is blind to it.

## Decision summary

- New deterministic pattern kind `peer_practice`: an org-shared, actively-run
  flow owned by someone else, over providers U demonstrably touches, that U has
  no equivalent of.
- Same quiet pipeline: patterns → eligibility gate → the one weekly suggestion.
  No new surfacing, no new suggestion kinds.
- **Privacy rules (load-bearing):**
  - Only flows with `visibility != 'private'` are ever considered.
  - The pattern names the FLOW, never its owner. No teammate identity appears
    in summaries, evidence, prompts, or the graph insight.
  - Evidence event ids are always U's OWN ledger events (their tool_call
    events on the overlapping providers) — never another user's events.

## Deterministic miner (`src/lib/behavior/mine-peer-practices.ts`)

Pure function, same contract as the phase 1 miners. Inputs are U's ascending
ledger events plus loaded `PeerFlowInput`s:

- `peerFlows`: org flows where `visibility != 'private'`, `userId != U`,
  published (`status = 'ACTIVE'` or `publishedGraph != null`), with
  `successfulRuns` (count of succeeded runs in the last 30 days) and
  `providers` (the runtime provider strings its runs actually touched).
- `ownFlowProviders`: provider sets of U's OWN flows (draft or published), to
  suppress "you already have one".

Rule — a candidate exists when ALL hold:
1. `successfulRuns >= 3` (the practice is real, not an experiment).
2. `overlap = providers ∩ U's touched providers` (from U's `tool_call` events)
   has `>= 1` provider.
3. No flow of U's own covers the peer flow's provider set (superset match).

Candidate shape: slug `peer:flow:<flowId>`, kind `peer_practice`,
`occurrenceCount = successfulRuns`, `firstSeenAt = firstRunAt`,
`lastSeenAt = now` (the practice is observed at mining time, so the staleness
gate decays it once the peer flow stops running), evidence = U's `tool_call`
event ids for the overlapping providers.

Summary template (no owner identity): `Teammates run "<flow name>" over
<providers> — <n> successful runs in the last 30 days; you work with
<overlap> but have no similar automation`.

## Provider resolution (the loader, in `infer-user-patterns.ts`)

Flow graphs store connection ids, not runtime provider strings — but phase 1's
`tool_call` events (context `{provider, toolNames, executionId}`) already use
the runtime vocabulary, and flow runs flush them with `executionId = run.id`.
So the loader derives each peer flow's providers from the LEDGER, not the
graph: org-wide `tool_call` events (90-day window, capped) grouped by
`context.executionId`, joined to the peer flows' succeeded run ids. A flow
whose runs predate phase 1 capture simply has no providers yet and mines
nothing — correct cold-start behavior, no backfill needed.

Best-effort: any query failing degrades to no peer candidates that day.

## Eligibility (`eligibility.ts`)

`peer_practice` gates like `capability_gap`: occurrence/span minimums bypassed
(occurrenceCount is teammate runs, already thresholded at >= 3 by the miner;
span is not meaningful), staleness and U's learning period still apply.

## Graph projection (`user-insights.ts`)

Peer insights flow through the existing `writeUserInference` path (private
insight node, `evidence` edges to U's events). Additionally, a
`peer:flow:<flowId>` slug emits a `relates_to` edge from the insight to the
flow node — traversal can go peer-insight → flow → (runs, agents).

## Synthesis (`suggest-user-workflows.ts`)

One system-prompt line: peer_practice patterns describe org-shared automations
that already exist — prefer suggesting the user adopt or adapt the existing
flow (kind `enhancement` targeting it, or `new_flow` for a personal variant)
over inventing something new; citation contract unchanged.

## Testing

- Miner: pure-function tests — qualifying case, each rule's rejection
  (too few runs, no overlap, own-flow superset), privacy (summary never
  contains an owner id), evidence is U's events only.
- Eligibility: peer_practice bypass + staleness.
- Loader grouping: pure helper test for executionId → providers grouping.
