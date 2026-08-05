# Day-One ROI: Measured Process Baselines

**Date:** 2026-08-03
**Status:** Draft for review
**Branch:** feat/goal-recovery-plans

## Problem

The landing page promises agents that generate ROI on day one. The platform
cannot currently deliver a defensible version of that claim.

After a user onboards and connects their tools, Sublime does produce workflow
suggestions — but they are qualitative and ungrounded. A user reads them as
"the AI is guessing," and they are right to: nothing in the pipeline between
raw provider history and the suggestion the user sees ever computes a number.

The target: **within 3–4 hours of connecting tools, a new organization sees
concrete, costed recommendations derived from measured facts about how they
actually work** — templates to adopt, processes to improve, costs to cut —
each carrying an hours/dollars figure traceable to observed history.

## What already exists

The ingestion half of this is built and works.

| Layer | Module | State |
|---|---|---|
| Historical pull | `src/lib/activity/backfill.ts` | Cursor-checkpointed, resumable, 90d default |
| Auto-trigger on connect | `src/lib/activity/auto-backfill.ts` | Fires for `github`, `google_calendar`, `hubspot` |
| Normalization | `src/lib/activity/sources/*.ts` | 5 adapters |
| Ledger | `src/lib/activity/ledger.ts` → `ActivityEvent` | Per-org dedupe, replay-safe |
| Graph projection | `src/lib/activity/index-activity.ts` | Best-effort |
| Citation invariant | `src/lib/activity/insights.ts` | Inference rejected without evidence |
| Cost model | `src/lib/goals/impact.ts` | Hours × `laborHourlyRate` vs AI token cost |

Two of these deserve emphasis because the design leans on them.

`insights.ts` structurally refuses to write an `inferred_pattern` without
`>=1` evidence edge, or a `recommendation` without `>=1` `based_on` edge.
That discipline is exactly right and exactly what user-facing suggestions
lack today.

`impact.ts` already computes `hoursSaved → laborValueUsd → roiMultiple` from
a workspace-wide `laborHourlyRate` (settable via `PATCH /api/goals/settings`
under the `settings:workspace` capability). Day-one ROI must reuse this, not
introduce a parallel cost model.

## Root cause

Three defects, in dependency order. The third is the visible symptom; the
first is the cause.

### 1. The event feed carries almost no process signal

Five adapters emit eight distinct actions, and most emit exactly one:

| Source | Actions |
|---|---|
| HubSpot | `created_deal` |
| Google Calendar | `held_meeting` |
| Granola | `took_meeting_notes` |
| GitHub | `opened_pr`, `opened_issue`, `pushed_commit` |
| Slack | `posted_message`, `replied_in_thread` |

**No adapter populates `previousState`.** The field is plumbed end to end —
declared in `NormalizedActivity`, persisted by `ledger.ts:47`, rendered by
`index-activity.ts:22` — and written by nothing. Cycle time is derived from
state transitions, so with no transitions in the ledger, questions like
"how long do deals sit in Negotiation" are unanswerable from collected data.

After a full 90-day backfill an org's history supports *"you created 214
deals and held 380 meetings."* It does not support *"deals sit in
Negotiation 11 days and 40% see an owner reassignment first"* — the class of
statement that yields a costed recommendation.

### 2. Nothing measures

No step turns `ActivityEvent` rows into per-process quantities. `impact.ts`
computes ROI only retroactively from Sublime's own completed runs, which on
day one is an empty set. There is no denominator for a day-one claim.

### 3. Suggestions are uncosted and uncited

`suggest-workflows.ts` emits `{ title, description, flowPrompt }`. No hours
figure, no evidence pointer, no confidence, no provenance. The synthesis
prompt is not badly written — it is reasoning over a feed with no process
signal, so generalizing is its only option.

Its gates compound this. `meetsSuggestionGate` requires ≥3 active
connections; `meetsUsageEvidenceGate` requires ≥10 usage events in 30 days
where `USAGE_EVENT_KINDS` counts in-app actions (`tool_call`,
`agent_run_manual`, `flow_run_manual`, `copilot_prompt`, `assistant_prompt`)
— all zero for a new org. Backfilled `ActivityEvent` rows do count toward the
same total, so day-one firing is *possible*, but as a raw count with no
notion of "backfill finished" or "history is deep enough." Day-one behavior
today is accidental, not designed.

## Design

Four phases. Phases 1–2 are the substantive work; 3–4 follow mechanically
once a baseline row exists.

### Phase 1 — Deepen the event feed

Extend adapters to emit state transitions and a wider verb set, so the ledger
carries process signal rather than creation counts.

**HubSpot** is the highest-value target for the RevOps positioning. Add:
deal stage changes (with `previousState`/`newState` carrying the stage),
task completion, logged emails and calls, owner reassignment, note creation.
Stage-change events are what make cycle time computable.

**GitHub**: PR review submitted, PR merged, PR/issue closed. Merge events with
`previousState` give review latency.

**Slack** and **Granola** have working adapters but sit outside
`NANGO_BACKFILL_SOURCES`, so their history is never auto-pulled on connect.
Slack is excluded deliberately — its adapter keys `connectionRef` on
`SlackWorkspaceConnection.id`, not a Nango connection id — so widening
coverage requires a trigger on the Slack connect path rather than adding a
string to the set.

Rule for every adapter change: any event representing a change to an existing
entity **must** populate `previousState`. This is the phase's acceptance
criterion.

### Phase 2 — Process baselines

New module `src/lib/baselines/`. Deterministic aggregation over
`ActivityEvent` — no LLM in this phase. LLM involvement here would reintroduce
the unfalsifiability the whole design exists to remove.

A **process baseline** is a recurring `(source, action, entityType)` pattern
with measured properties:

- `volume` — event count in the observation window
- `windowDays` — observation window actually covered (not the requested one;
  a backfill that returned 40 days of a 90-day request reports 40)
- `periodDays` — median inter-event interval
- `distinctActors` — how many people perform it
- `medianCycleTimeHours` — for transition pairs only; null otherwise
- `reworkRate` — fraction of entities that re-enter a state they previously
  left (a backwards transition); null when the pattern has no transitions
- `confidence` — derived from volume and window coverage

Persisted as a new `ProcessBaseline` model keyed
`@@unique([organizationId, source, action, entityType])`, recomputed on
demand rather than incrementally maintained.

Baselines are facts. They are written to the graph as `inferred_pattern`
nodes through the existing `writeInference` path, so each one cites the
activity events it was computed from and inherits the evidence invariant.

**Handling-time model.** A curated, versioned table in the repo maps action
types to estimated minutes of human handling — e.g. `logged_email: 4`,
`deal_stage_changed: 2`, `took_meeting_notes: 15`. Deterministic, auditable,
identical across customers, and reviewable in a QBR.

Organizations may override any entry via a `handlingTimeOverrides` key in org
settings, following the exact pattern `laborHourlyRate` already uses —
`mergeOrgSettings` for atomic key-level merge, `settings:workspace`
capability, since these values feed every ROI figure the org sees. Overrides
are surfaced during onboarding as an optional confirmation step, never a
blocking one; the curated table is always a working default.

The table's version is recorded on each baseline so a later table revision
does not silently restate historical figures.

### Phase 3 — Costed, cited suggestions

Extend the suggestion payload with:

- `baselineId` — the measured process it derives from
- `estimatedHoursSavedPerPeriod` — `volume × handlingMinutes × automatable
  fraction ÷ 60`
- `estimatedValueUsd` — via the existing `impact.ts` labor-rate path
- `provenance` — `'measured'` when derived from a baseline meeting a
  confidence floor, `'benchmark'` when derived from catalogue defaults
- `handlingTimeTableVersion`

A suggestion with `provenance: 'measured'` must reference a baseline; this is
validated at write time, mirroring the `insights.ts` invariant rather than
trusting the model to comply.

The `meetsUsageEvidenceGate` check is replaced by a baseline-coverage gate:
synthesis runs when at least one baseline clears the confidence floor,
regardless of in-app event count. `meetsSuggestionGate`'s 3-connection
requirement is retained.

UI surfaces the number and its provenance. A benchmark-derived suggestion is
labeled as an estimate from comparable organizations, never presented as
measured. Honest degradation is a requirement, not a nicety — a fabricated
"measured" number destroys the trust the feature exists to build.

### Phase 4 — Onboarding orchestrator

Today each backfill is fire-and-forget; nothing observes completion or
sequences what follows. The 3–4 hour promise needs a tracked pipeline.

A per-org readiness state machine over existing `ActivityBackfill` rows:

```text
connecting → ingesting → measuring → synthesizing → ready
                              ↓
                        insufficient_history → ready (benchmark mode)
```

Transitions are driven by backfill row status, not wall-clock timers. When
all backfills for an org reach `done` or `partial`, measurement runs; when
baselines are written, synthesis runs; when suggestions land, the org is
`ready` and is notified.

`insufficient_history` is entered when no baseline clears the confidence
floor. It is not a failure state — it routes to Phase 3's benchmark path so
day one always produces something, labeled accurately.

The state is readable by the UI so onboarding can show real progress
("reading 90 days of HubSpot history…") instead of an indeterminate spinner.

## Implementation sequencing

This spec is too large for one implementation plan. It splits at a natural
seam:

- **Plan 1 — Phases 1 and 2.** Adapter enrichment and the baselines module.
  Ships nothing user-visible; delivers measured baselines and the data to
  validate them against. Independently verifiable: baselines computed from a
  real backfill should match hand-counted figures.
- **Plan 2 — Phases 3 and 4.** Costed suggestions and the onboarding
  orchestrator. Depends on Plan 1's `ProcessBaseline` model existing.

## Scope boundaries

**In scope:** adapter enrichment for HubSpot, GitHub, Slack backfill
triggering; the baselines module and its model; handling-time table plus
override path; suggestion payload extension and gate replacement; onboarding
state machine and its read API.

**Out of scope:** new provider adapters (Salesforce, Jira, Linear, Notion,
Gmail); changes to `impact.ts`'s post-hoc ROI computation; the onboarding UI
itself beyond the state read API; landing-page copy, which is already done.

## Risks

**Backfill latency exceeds the window.** A large HubSpot portal may not
finish a 90-day pull in 3–4 hours. Mitigated by measuring over `partial`
backfills — `windowDays` records actual coverage, and confidence scales with
it — so partial history still produces labeled, lower-confidence baselines.

**Handling-time estimates are wrong for a given org.** Mitigated by the
override path and by never presenting estimates as measured. The volume is
measured; the minutes-per-action are explicitly an estimate, and the UI must
say so.

**Adapter enrichment increases event volume substantially.** Stage changes
and task completions are far more frequent than deal creation. Ingest is
already batched and dedupe-guarded, but retention and index cost need review
before Phase 1 ships.

**Provider APIs may not expose history for the new event types.** HubSpot
stage-change history in particular depends on the portal's plan tier. Phase 1
must verify availability per event type before the baseline layer is designed
around it; where transitions are unavailable, cycle-time fields stay null and
volume-only baselines still work.

## Verification: HubSpot property history (2026-08-03)

**Status: UNVERIFIED — no portal available, not a negative result.**

`scripts/spikes/hubspot-history-probe.mjs` ran against the configured Nango
account. It holds two connections, `slack` and `asana`; no HubSpot connection
exists, so `GET /crm/v3/objects/deals?propertiesWithHistory=dealstage` was
never exercised against a real portal.

This is distinct from the failure case the plan anticipated. "History came
back empty" would mean skipping the stage-change work; "there was nothing to
ask" means the question stands open.

Consequences taken:

- The stage-change normalizer (`hubspotStageChangeActivities`) is implemented
  and unit-tested against fixtures. It is correct with respect to HubSpot's
  documented newest-first history shape and is inert if history never arrives —
  an absent `propertiesWithHistory` yields zero events.
- `listDealsWithHistory` is implemented, exported, and tested, but the backfill
  generator's deals phase **still calls `searchDeals`**. Switching the live
  path is deferred until a portal confirms the response shape: the list
  endpoint also loses server-side `createdate` filtering, so swapping it in
  unverified would trade a working fetch for a slower one with no gain.
- Until the swap, HubSpot baselines are volume-only in practice.
  `medianCycleTimeHours` and `reworkRate` stay null for `deal_stage_changed`
  because no such events are ingested.

To close this out: connect a HubSpot portal, run
`node scripts/spikes/hubspot-history-probe.mjs` to list connections, re-run it
with the connection id, and if `historyEntries >= 2` appears, change the deals
phase in `src/lib/activity/sources/hubspot.ts` from `searchDeals` to
`listDealsWithHistory`.

## Open questions

None blocking. Handling-time sourcing is decided (curated table default,
optional org override). Phase 1 API verification is implementation work, not
a design decision.
