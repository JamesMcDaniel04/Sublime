# Data capture hardening — design

Date: 2026-07-29

## Problem

Cross-customer aggregation drives template recommendations, but the capture
layer feeding it has three defects that make the corpus untrustworthy.

The platform already has a mature cross-tenant intelligence layer with a
consistent posture: global tables carry counts and platform vocabulary only,
never org/user/content identifiers, and a row may only exist once enough
distinct orgs share it. `PlatformArchetype`, `GoalBenchmark`, and
`TemplateEstimateCalibration` all follow this — each is written by a gated
sweep in `src/app/api/cron/dispatch/route.ts` and each enforces a k-anonymity
floor at the write boundary.

Template adoption scoring does not follow it, and the behavior ledger under it
records only successes.

### Defect 1 — adoption scoring has no k-anonymity floor

`loadTemplateAdoptionScores` in `src/lib/templates/adoption.ts` queries raw
cross-org `UserEvent` rows through `systemPrisma` at request time and ranks
templates by deploy and survival counts with no minimum-distinct-org
threshold. It is the only global aggregate in the codebase without one.

Consequences: a single org's deploy burst reshapes every other customer's
ranking, and a count of 1 is attributable to one customer. The privacy rule
that the other three aggregates enforce structurally is here merely a
convention that no reader is obliged to honor.

### Defect 2 — silent truncation

The same function caps at `MAX_EVENTS = 5_000` ordered by `occurredAt desc`.
Today that is slack. As volume grows the ranking silently becomes "templates
deployed in the last few days" with no signal that older data was dropped.
The scheduled sweeps do not have this problem because they roll up on a
cadence rather than sampling at read time.

### Defect 3 — success-only capture

`USER_EVENT_KINDS` in `src/lib/behavior/record-event.ts` records
`connection_added` with no removal counterpart, and `goal_achieved` with no
abandonment counterpart. `recordToolCallEvents` records which integrations a
run touched but never whether the run worked.

Consequence: the corpus is survivorship-biased, and "which integrations
actually carry a goal kind" is unanswerable from the ledger.

## Scope

This spec covers defects 1–3 only.

Explicitly deferred: conditioning template recommendations on an org's
configured integration set. That join does not exist today —
`PlatformArchetype` has provider sets but describes flow shapes, and
`GoalBenchmark` has outcomes but is keyed on goal kind alone. It gets its own
spec once the capture layer produces data worth joining. The
`tool_call.succeeded` flag added here is the signal that work will need.

## Non-goals

- No new event kinds for run failures. `FlowRun.status` and
  `AgentExecution.status` already persist terminal outcomes durably, and the
  agent executor writes terminal status at roughly ten scattered sites in
  `src/features/agents/execute-agent.ts`. Instrumenting each is fragile and
  guarantees drift. A daily sweep reads those tables instead.
- No template-retirement event. The sweep's "still ACTIVE" re-query is
  adequate once it is off the request path.
- No change to `adoptionScore` or `sortByAdoption`. They are pure and correct.

## Part 1 — `TemplateAdoption` aggregate

### Model

Mirrors `GoalBenchmark`'s shape.

```prisma
/// Global k-anonymous template adoption counts. Rows exist only while at
/// least MIN_ADOPTION_ORGS distinct orgs have deployed the template; org
/// identities never cross workspace boundaries.
model TemplateAdoption {
  templateKey String   @id // "seed:<seedKey>" | "db:<templateId>"
  deploys     Int
  surviving   Int
  orgCount    Int
  updatedAt   DateTime @updatedAt @db.Timestamptz(6)

  @@map("template_adoptions")
}
```

`orgCount` is stored rather than merely checked, matching `PlatformArchetype`
and `GoalBenchmark`, so the floor is auditable after the fact.

### Sweep

New module `src/lib/templates/aggregate-adoption.ts`, exporting the same three
symbols as `src/lib/intelligence/aggregate-archetypes.ts`:

- `MIN_ADOPTION_ORGS = Math.max(2, Number(process.env.TEMPLATE_ADOPTION_MIN_ORGS) || 5)`
- `shouldRunAdoptionSweep(now: Date): boolean` — daily gate
- `aggregateTemplateAdoption(): Promise<void>`

Behavior:

1. Page the 90-day `template_used` window with a cursor. No `take` cap — the
   sweep is off the request path, so completeness beats latency. This closes
   defect 2.
2. Accumulate per template key: `deploys`, the set of distinct
   `organizationId`, and the set of deployed resource ids.
3. Re-query survival — deployed `AgentTask` rows still `ACTIVE`, deployed
   `Flow` rows still `ACTIVE` with a published graph — exactly as the current
   read-time implementation does.
4. Delete rows whose key fell below `MIN_ADOPTION_ORGS`, upsert rows at or
   above it. Deletion rather than staleness matters: a template that decays
   out of k-anonymity must stop influencing rankings, not linger at its last
   qualifying value.

Only counts are written. Org ids, user ids, resource ids, and names stay
inside the sweep.

### Read path

`loadTemplateAdoptionScores` keeps its exact exported signature and its
never-throw contract, but reads `TemplateAdoption` instead of aggregating
`UserEvent`. `systemPrisma` leaves the request path. The existing 10-minute
cache becomes unnecessary against a small indexed table and is removed.

Because the signature and the pure helpers are unchanged,
`src/lib/goals/emit-recommendation.ts` and
`src/app/api/templates/provision/route.ts` need no modification.

Degradation is unchanged: an empty table yields an empty map, and ranking
falls back to persona and readiness ordering.

### Cron wiring

One gated block in `src/app/api/cron/dispatch/route.ts` beside the existing
three, using the same dynamic import and `void ... .catch(() => undefined)`
posture so an aggregation failure can never fail the dispatch tick.

## Part 2 — capture coverage

Three additions at the existing chokepoint. No new plumbing; all remain
fire-and-forget, references-only, inside the documented privacy contract.

### `tool_call` outcome

`recordToolCallEvents` gains a required `succeeded: boolean` param, written
into event context. Both call sites already run at run completion where the
outcome is known:

- `src/features/agents/execute-agent.ts:1416`
- `src/features/flows/execute-flow.ts:890`

This converts integration *usage* into integration *outcome*, and is the join
key the deferred recommendation work will need.

### `connection_removed`

New kind in `USER_EVENT_KINDS`, emitted at the three deletion sites:

- `src/app/api/mcp-connections/route.ts:268`
- `src/app/api/nango/status/route.ts:158`
- `src/app/api/nango/connections/[integrationId]/route.ts:42`

Pairs with the existing `connection_added` so
`src/lib/behavior/mine-correlations.ts:137` stops treating churned connectors
as permanently held.

### `goal_abandoned`

New kind, emitted where a goal is archived —
`src/app/api/goals/[id]/route.ts:310`. This is the missing negative outcome
beside `goal_achieved`.

## Testing

- **`aggregate-adoption`** — pure-ish sweep tested against a real Postgres per
  the `verify` skill protocol: below-floor keys produce no row; a key that
  drops below the floor has its existing row deleted; paging covers events
  beyond one page; survival counts only still-ACTIVE resources; counts are
  correct across multiple orgs.
- **`adoption`** — `loadTemplateAdoptionScores` reads the table, returns an
  empty map on error, and never throws. Existing `adoptionScore` and
  `sortByAdoption` tests stay green unmodified, which is the regression proof
  that ranking behavior did not change.
- **capture** — each new emission asserted at its call site with an injected
  recorder, following the existing `recordUserEvent` dependency-injection test
  pattern; and asserted fire-and-forget, i.e. a recorder that throws does not
  fail the user action.
- **privacy** — an explicit test that no `TemplateAdoption` row can be written
  below `MIN_ADOPTION_ORGS`, since that invariant is the point of Part 1.

## Migration and rollout

One Prisma migration creating `template_adoptions`. Empty on deploy, which
degrades ranking to persona and readiness ordering until the first daily sweep
runs — acceptable and self-healing.

No backfill is needed: the sweep reads the existing 90-day `UserEvent` history
on its first run and reconstructs the full picture.

`TEMPLATE_ADOPTION_MIN_ORGS` is optional; the default of 5 matches
`PLATFORM_ARCHETYPE_MIN_ORGS`.
