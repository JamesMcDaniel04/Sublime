# Home: Goals-in-Flight Mini Tracker

**Date:** 2026-08-13 (amended 2026-08-14)
**Status:** Approved

> **2026-08-14 amendment:** the strip now **replaces** the RecentFlows
> section instead of stacking above it (explicit product decision: "replace
> the flows on the home page with the mini goal tracker"). See Placement.

## Goal

Put a compact, honest per-goal log on Home: the 3 most recently created active
goals, each with how far the goal has moved, what the AI work toward it cost,
how much run time it consumed, and the estimated value created — plus a
"View all →" link to the goals surface. A mini log, not a second goals
dashboard.

## History this must respect

Home previously rendered a goal status strip and an org-wide impact line; both
were deliberately removed (see the tombstone comment in
`src/app/(app)/g/[scope]/dashboard/home-assistant.tsx`) because the goal lens
made them redundant and `/api/goals/impact` is an N+1 per contribution. This
strip differs on both counts:

- It is **per-goal and capped at 3**, not org-wide.
- Its server loader is **flat (3 queries total)** regardless of goal or
  contribution count — no N+1, no datapoint reads.
- It renders **only under the all-goals lens**. Under a single goal's lens
  that goal has a whole surface with a fuller impact strip; a "top 3" list
  next to a "View all" link would read as a bug there.

## The four numbers

| Column | Meaning | Source |
| --- | --- | --- |
| MOVED | `currentValue − startValue` on the goal's primary metric — the goal's actual movement since it was set | already in the `/api/goals` payload (`GoalSummary`) |
| SPENT | `aiCostUsd` — tokens consumed by linked runs × the workspace's per-M-token rate | new batch loader |
| TIME | measured `aiRunSecondsTotal` across linked runs | new batch loader |
| VALUE | `laborValueUsd` — hours saved estimate × the workspace hourly rate | new batch loader |

"Revenue generated" is answered by **both** MOVED (the honest, measured
movement — for an ARR/quota goal in USD this literally is revenue booked while
pursuing it) and VALUE (the existing labor-value estimate). They are labelled
distinctly; VALUE's column tooltip says "estimated".

### Formatting rules

- MOVED on a percent goal renders in **percentage points** (`−1.2pp`), not
  through `fmtValue` (which multiplies by 100 and appends `%`, correct for
  levels but wrong-reading for deltas). A dedicated delta formatter lives in
  the new pure module.
- MOVED is colored by **direction agreement**, not sign: a negative delta on a
  `direction: 'decrease'` goal (churn, savings) is favorable/green. Sign-only
  coloring would paint every successful cost-reduction goal red.
- `currentValue === null` (no data yet) renders `—` with no color.

## Server: batched per-goal impact

New `goalImpactBatch(organizationId, goalIds)` in `src/lib/goals/impact.ts`,
alongside the existing `goalImpact` (unchanged; the goal detail page keeps its
pace-delta tier).

Three queries, always:

1. `goalContribution` where `goalId IN ids` — select goalId, resourceType,
   resourceId, estimatedMinutesSavedPerRun, createdAt.
2. `flowRun` where `flowId IN (flow resourceIds)`, `status: 'succeeded'`,
   `startedAt > min(contribution.createdAt)` — select flowId, startedAt,
   finishedAt.
3. `agentExecution` where `agentTaskId IN (agent resourceIds)`,
   `completedAt not null`, `error: null`, `startedAt > min(createdAt)` —
   select agentTaskId, startedAt, inputTokens, outputTokens, executionTime.

Rows are bucketed per contribution **in JS** against that contribution's own
`createdAt` (the SQL cutoff is the earliest cutoff, so per-contribution
filtering must re-apply `startedAt > createdAt`), then fed through the
existing tested pure functions `flowRunStatsOf` / `agentRunStatsOf` →
`computeImpact` with `paceBefore/After: null`. Duration and measurability
rules stay defined in exactly one place. No `metricDatapoint` reads.

Known trade-off (accepted): a high-volume flow transfers many run rows to the
app server. The alternative (raw SQL aggregates) would duplicate the duration
rules outside the tested pure functions.

Returns `Map<goalId, ImpactTiers>`; goals with no contributions get the zero
impact shape (not absent), so the client needn't special-case.

### Route

`GET /api/goals/impact/batch?ids=a,b,c`

- `requires: 'member'`, runtime nodejs.
- Ids capped at **3**; more is a 400.
- Ids are filtered through `goalReadWhere(userId, { isAdmin })` scoped to the
  org before loading. Ids the caller may not see are **silently dropped**
  (absent, never 403 — the confidential-goal rule).
- Response: `{ success: true, impact: { [goalId]: ImpactTiers } }`.

## Client: pure selection + formatting

New `src/lib/goals/tracked.ts` (pure, no React — the `lib/flows/recent.ts`
pattern):

- `pickTrackedGoals(goals)` — filters to `status === 'active'`, sorts by
  `startAt` descending (creation recency), takes 3. Tolerates `undefined`
  input by returning `[]`.
- `goalMovement(goal)` — `{ text: string, favorable: boolean | null }`.
  Handles null currentValue, percent→pp, usd/count via the compact formatter,
  explicit `+`/`−` sign, favorability from `direction`.

## UI: `goals-in-flight.tsx`

`src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx`, a client component
replacing `recent-flows.tsx`.

Layout — labelled columns, one row per goal:

```
Goals in flight                              View all →

  GOAL              MOVED     SPENT   TIME    VALUE
● Q3 New ARR    +$142,000    $18.40   6.2h   $3,100
● Pipeline       +$61,000     $9.10   2.4h   $1,200
● Logo churn       −1.2pp     $4.05   1.1h     $520
```

- Header "Goals in flight" with a "View all →" `ScopedLink` to `/goals`, same
  typography as the RecentFlows header.
- Each row is a link to `/goals/{id}` (scoped).
- Risk dot per row reusing the goal-card risk palette (on_track emerald,
  at_risk amber, off_track rose, no_data border).
- SPENT/TIME/VALUE render `—` until the batch response lands; TIME uses the
  existing duration formatting behavior (s/m/h).
- Mobile: columns collapse to stacked label/value pairs per goal.

### Data flow

- Goals come from the `/api/goals` fetch Home **already makes** — the
  component receives the loaded `GoalSummary[]` as a prop from HomeAssistant
  (no second fetch of the same URL).
- After goal ids are known, one `useCachedJson` call to
  `/api/goals/impact/batch?ids=…` (ids sorted for a stable cache key).

### Placement & visibility

- In the empty-state hero, **in place of** `<RecentFlows />`, under the same
  `input.trim() === ''` guard — a drafted message keeps the screen.
- `recent-flows.tsx`, `src/lib/flows/recent.ts`, and their tests are
  **deleted** with the swap; nothing else imports them. The Flows page
  remains the home of flow discovery.
- Renders **nothing** while goals are loading, on error, when zero active
  goals exist, or when the lens is a single goal (`scope !== ALL_SCOPE`).
  It is a shortcut, not a source of truth; `/goals` owns errors and empties.
- The impact fetch failing degrades to `—` cells; the strip itself stays.

## Testing

- Unit: `pickTrackedGoals` (filtering, ordering, cap, undefined input),
  `goalMovement` (null current, percent pp, decrease-direction favorability,
  sign rendering), and the batch bucketing (per-contribution cutoff re-applied
  in JS; a run before its contribution's createdAt but after the batch min
  must not count).
- Route smoke: `/api/goals/impact/batch` — member can read; ids cap enforced;
  a restricted goal the caller is not a member of is absent from the response
  (never 403); another user's personal goal likewise absent.

## Out of scope

- Any change to the goal detail page's impact tiers or `/api/goals/impact`.
- Persisted/rollup cost tracking beyond what contributions already imply.
- Showing the strip under a single-goal lens.
