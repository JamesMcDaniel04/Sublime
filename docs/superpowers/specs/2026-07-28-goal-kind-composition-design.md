# Per-kind goal composition: ARR, Quota, KPI

**Date:** 2026-07-28
**Status:** approved, ready for planning

## Problem

`Goal.kind` is nearly inert. It does exactly two things: picks the unit via
`GOAL_KIND_UNITS`, and filters which templates and agent bundles surface. It
does not change what gets tracked, what the dashboard renders, how risk is
computed, or what the report says. An ARR goal and a Quota goal are the same
machine wearing different labels, plus a different default recurrence.

The per-kind depth that does exist is prefill-only and evaporates at creation.
`GoalTemplate` carries `tracks`, ranked `sources`, curated `agents`, a `layout`,
`motion`, and `produces` — all of it wizard prefill. After the goal row is
written only `templateKey` survives, read solely to offer agent bundles.

The structural blocker is single-metric evaluation. `refresh.ts:147` evaluates
`metrics: { where: { role: 'primary' }, take: 1 }`. Risk, projection,
settlement, the trend chart, and the entire report hang off one scalar.
`role: 'supporting'` metrics render in widgets but never touch risk or
settlement — so a headline can look healthy while its drivers rot, and nothing
in the system notices.

ARR, Quota, and KPI each need to stand on its own as a product that a workspace
could build its whole ROI story around. That means each must track a
*composition* that rolls up, not one number with decorative context.

This spec is sub-project 1 of a five-part program (§8). It is the keystone:
the evidence-row shape, the widget set, and what the report can prove are all
downstream of the decisions here.

## 1. Kind reduction

The enum collapses from seven to three: `arr | quota | kpi`.

```sql
UPDATE goals SET kind = CASE kind
  WHEN 'mrr'        THEN 'arr'
  WHEN 'revenue'    THEN 'arr'
  WHEN 'savings'    THEN 'kpi'
  WHEN 'lead_gen'   THEN 'kpi'
  WHEN 'custom_kpi' THEN 'kpi'
  ELSE kind END;

DELETE FROM goal_benchmarks WHERE kind NOT IN ('arr', 'quota', 'kpi');
```

Deleting benchmark rows is safe and lossless in effect.
`aggregateGoalBenchmarks` recomputes every row from source on each Monday sweep
— it groups `goals` and `goal_periods` by `g.kind` and upserts. The counts are
derived, not accumulated, so the next sweep rebuilds correct rows under the
three new keys. Stale rows under retired keys would otherwise linger forever
and never be read, since `surfaceGoalBenchmark` looks up by kind.

`GOAL_KIND_UNITS` becomes `arr: 'usd'`, `quota: 'usd'`, `kpi: null`. `kpi` is
null so the user chooses, which preserves what former `savings` (usd) and
`lead_gen` (count) rows already store in their own `unit` column — `unit` is a
`Goal` column, so existing values survive the kind remap untouched. `direction`
is likewise a column, so decreasing cost goals stay decreasing.

Three inferred defaults lose their basis and become explicit values:

| Site | Today | After |
|---|---|---|
| `goal-templates.ts:114` | `kind === 'savings' ? 'decrease' : 'increase'` | explicit `direction` on each affected template |
| `goal-templates.ts:119-121` | `quota` → quarterly; `mrr`/`lead_gen` → monthly | `quota` → quarterly kept; explicit `recurrence: 'monthly'` on the former mrr/lead_gen templates |
| `copilot.ts:353` | `kind === 'savings' ? 'decrease' : data.direction` | `data.direction`, with prompt guidance so the model picks `decrease` for cost-reduction KPIs |

Mechanical remapping surface: the kind literals across the 46 `template(...)`
entries in `GOAL_TEMPLATES`, the six `goalKinds` arrays in `SEED_CATALOGUE`, the
two `GOAL_KINDS` enums (`copilot.ts:18`, `api/goals/route.ts:15`), and
`GOAL_KIND_LABELS` / `GOAL_KIND_UNITS` in `types.ts`.

`goalKinds` arrays must **dedupe** after remapping — `['arr','mrr','revenue','quota']`
collapses to `['arr','quota']`, and `['lead_gen','revenue']` to `['kpi','arr']`.
A naive map leaves duplicates that skew nothing functionally but make
`goalTemplatesFor` matching read as though a seed were listed twice.

## 2. Components are `GoalMetric` rows

A component is a number with a source that needs refreshing on a cadence, with
error state and history. That is precisely what `GoalMetric` already is, so
components reuse the connector registry, the refresh throttle, datapoint
provenance, and bucketKey-derived coverage for free. A separate `GoalComponent`
model would duplicate all of it, and `parentGoalId` is already taken by
personal-goal rollups.

```prisma
model GoalMetric {
  role String @default("primary") // 'primary' | 'supporting' | 'component'
  slot String?                    // 'new_arr' | 'stage:2' | 'pipeline_coverage' | null

  @@unique([goalId, slot])
}

model Goal {
  /// Shape declaration: KPI's chosen shape, weights, per-rep targets,
  /// variance tolerance. Null = uncomposed; behaves exactly as today.
  composition      Json?
  /// Small summary written at each evaluation (level, variance, breached
  /// gates) so the goals list renders a composition badge without loading
  /// every component for every card.
  compositionState Json?
}
```

The metric cap in the create route rises from `max(4)` to `max(12)`. With
Quota's per-rep tracking living in child goals (§3), no kind needs more than
about six metrics, so the `MAX_METRICS_PER_TICK = 200` refresh budget is
unaffected. A cap of 12 leaves headroom without letting one goal consume a
meaningful share of a cron tick.

`GoalMetricSeries` in `types.ts` gains `slot: string | null` and the widened
`role`. The `role` zod enums at `api/goals/route.ts:36`, `copilot.ts:86` (JSON
schema) and `copilot.ts:202` (zod) widen to three values. `preview-data.ts:16`
follows.

## 3. Slot vocabularies

| Kind | Rollup source | Required slots | Optional slots | Derived |
|---|---|---|---|---|
| `arr` | component metrics, signed sum | `new_arr` +, `expansion_arr` +, `contraction_arr` −, `churned_arr` − | `customers_start`, `customers_churned` | net new ARR, NRR, GRR, logo churn |
| `quota` | **child goals**, summed | none | `pipeline_coverage`, `win_rate`, `avg_deal_size`, `sales_cycle_days` | team attainment %, per-rep attainment |
| `kpi` | component metrics, per declared shape | per shape (below) | — | stage conversions, end-to-end rate, driver shares |

KPI declares one of three shapes in `Goal.composition`:

- `funnel` — ordered `stage:1..n`; headline is the final stage or the
  end-to-end rate; derived per-stage conversions
- `ratio` — `numerator`, `denominator`; lands on the **existing** `ratio`
  widget and `ratioSeries` in `series-math.ts`, so this shape is mostly wiring
- `weighted_sum` — `driver:<key>` slots with weights in `GoalMetric.config`;
  covers the former `savings` case as a cost-category tree

### Why Quota rolls up child goals

`parentGoalId` + `ownerUserId` + `RollupsWidget` already model "personal goals
rolling into an org goal." Per-rep attainment is exactly that, so Quota's
rollup sums child goals while ARR's sums component metrics. Two genuinely
different rollup sources is the reason three hardcoded rollups beat one shared
engine: an abstraction would have to bridge children-vs-metrics for no benefit.

It also bounds metric count. Modelling 30 reps as component metrics on one goal
would have consumed 15% of every cron tick.

## 4. Evaluation core

`evaluateGoal` does not change. It stays pure, scalar, and exhaustively tested,
and it remains the only thing computing progress, pace, projection and base
risk. Composition is a wrapper that calls it and can only ever *downgrade* the
result. Every uncomposed goal keeps behaving identically — that is the
regression-safety property, and it is directly testable.

### Three independent rollups

Pure, no I/O, in `src/lib/goals/composition/`. Each returns
`{ derived, present, missing }` plus its own derived quantities.

```ts
// rollup-arr.ts
rollupArr(startValue: number, components: Map<string, number>): {
  derived: number | null          // startValue + new + expansion − contraction − churn
  present: string[]
  missing: string[]
  nrr: number | null              // (start + expansion − contraction − churn) / start
  grr: number | null              // (start − contraction − churn) / start
  logoChurn: number | null        // churned customers / start customers
}

// rollup-quota.ts
rollupQuota(
  children: Array<{ currentValue: number | null; targetValue: number }>,
  gates: Map<string, number>,
): {
  derived: number | null          // Σ children currentValue
  attainmentPct: number | null
  perRep: Array<{ currentValue: number | null; targetValue: number; attainmentPct: number | null }>
  gateFindings: Array<{ slot: string; value: number; threshold: number; breached: boolean }>
}

// rollup-kpi.ts
rollupKpi(shape: 'funnel' | 'ratio' | 'weighted_sum', components: Map<string, number>, config: unknown): {
  derived: number | null
  present: string[]
  missing: string[]
  stageConversions?: Array<{ from: string; to: string; rate: number }>
  driverShares?: Array<{ slot: string; share: number }>
}
```

Every derived quantity is `null` when its inputs are absent — never zero. A
missing input must not read as a real measurement of nothing, the same
principle `evaluateGoal` already applies by returning `no_data` for a stale
series.

### One shared post-rollup layer

These three concerns are identical no matter how the number was produced, so
they are implemented once even though the rollups are hardcoded per kind.

```ts
// reconcile.ts
reconcile({ read, derived, tolerancePct }): {
  variancePct: number | null
  status: 'reconciled' | 'drifted' | 'derived_only' | 'read_only' | 'unmeasured'
}

// completeness.ts
compositionCompleteness({ required, present, stale, errored }): {
  boundPct: number
  missing: string[]
  stale: string[]
  errored: string[]
  level: 'complete' | 'partial' | 'unbound'
}

// gates.ts
applyCompositionGates(baseRisk, { completeness, reconciliation, gateFindings }): {
  riskLevel: GoalRiskLevel
  reasons: string[]
}
```

Default variance tolerance is 5%, overridable in `Goal.composition`.

### Gating rules

| Condition | Effect |
|---|---|
| Required component missing | cap at `at_risk` |
| Required component stale or erroring | `no_data` — an unread driver is unread, the same rule the headline already obeys |
| Reconciliation `drifted` beyond tolerance | cap at `at_risk`, reason recorded |
| Leading gate breached (quota `pipeline_coverage` < 3.0) | cap at `at_risk` |

Gates only ever downgrade. Composition can never make a genuinely `off_track`
goal look better, and that invariant is tested exhaustively across every
(baseRisk × condition) pair.

### Integration

`evaluateComposite(goal, headlinePoints, composition, now, staleAfterMs)` calls
`evaluateGoal` for the base, then rollup → reconcile → completeness → gates,
returning the `Evaluation` plus a composition block.
`evaluateAndPersistGoal` in `refresh.ts` branches on
`goal.composition !== null` and otherwise takes the existing path unchanged.

Of the six `role: 'primary'` call sites, only `refresh.ts` loads components.
`impact.ts:224`, `grounding.ts:91`, `digest.ts:172`, `api/goals/route.ts:141`
and `api/goals/[id]/datapoints/route.ts:22` stay headline-only. The goals list
renders its composition badge from `Goal.compositionState`, avoiding an N+1
across cards.

## 5. Settlement as a receipt

`GoalPeriod` already has the exact shape of a settlement record —
`periodStart`, `periodEnd`, `startValue`, `targetValue`, `finalValue`,
`outcome` — but is written only for recurring goals. Non-recurring goals just
flip `status: 'achieved'` at `refresh.ts:327` with no timestamp and no recorded
final value, which makes the most common goal kind the one with the weakest
receipt.

`GoalPeriod` becomes the universal settlement record, written for non-recurring
goals at settlement too, with two nullable additions:

```prisma
model GoalPeriod {
  /// Component values that decided this settlement.
  compositionSnapshot       Json?
  /// Read-vs-derived variance at settlement.
  reconciliationVariancePct Float?
}
```

A settled goal then reads: *achieved at $2.41M, components summed to $2.38M
(−1.2%, within tolerance), all four required slots bound and fresh at
settlement* — auditable, rather than a status column asserting `achieved`.

This also unblocks `PeriodsWidget`, which currently returns null for
non-recurring goals, and gives the report period section real finals against
targets.

## 6. Minimum honest surface

Component-binding UI is mandatory here, not deferrable. Without it no composed
goal can be created at all, so every rollup, gate and receipt would be
unverifiable by hand.

- **Per-slot component binding** in the wizard and goal edit, reusing
  `metric-binding-fields.tsx`, which already handles source selection,
  connection choice and per-source config validation. A component is that same
  control rendered once per slot, labeled by the kind's slot vocabulary.
- **`CompositionStrip`** on the goal detail page: bound / missing / stale slots,
  reconciliation variance against tolerance, and any breached gate with its
  reason. This is the surface that makes gating legible rather than mysterious
  — a goal capped at `at_risk` must say why.

Full per-kind dashboards are out of scope (§8).

## 7. Testing

Following the existing pure-logic-first convention (`tsx --test`, `__tests__`
directories, pure math separated from I/O).

- `rollup-arr.test.ts`, `rollup-quota.test.ts`, `rollup-kpi.test.ts` —
  table-driven, covering all-missing, partial, negative-span, and
  zero-denominator cases; assert every derived quantity is `null` rather than
  `0` when inputs are absent
- `reconcile.test.ts` — all five statuses, variance sign in both directions,
  zero and null denominators
- `gates.test.ts` — the invariant: across every (baseRisk × condition) pair,
  the result is never better than the base
- `evaluate-composite.test.ts` — an uncomposed goal produces output identical to
  `evaluateGoal`, locking the no-regression property
- `kind-migration.test.ts` — pure mapping: every retired kind lands on a valid
  new kind, no orphan kinds remain in `GOAL_TEMPLATES` or `SEED_CATALOGUE`, and
  `goalKinds` arrays dedupe
- extend `goal-templates.test.ts`, which already asserts kind validity and the
  unit implication
- `composition-e2e.test.ts`, following the `multimetric-e2e.test.ts` pattern:
  build an ARR goal with four components, seed datapoints, run
  `evaluateAndPersistGoal`, assert gating and the settlement receipt

**Verification:** `npm test`, plus a route smoke against a throwaway Postgres
for the migration, via the project `verify` skill. Migrations are deployed to
the QA Postgres before any failure there is trusted.

## 8. Edition seams

The platform is becoming four editions — ARR, Quota, KPI, and Full — where the
edition gates creatable goal kinds, premade template visibility, and
kind-specific widgets. That is sub-project 2 and is out of scope here (§9), but
two things in *this* spec must be built so the gate drops in rather than
requiring a rewrite.

**Kind validation needs a seam, not a tangle.** §1 adds per-kind preset
validation to the create route (required slots, allowed shapes). Entitlement
checking lands at the same point. Keep the kind check as a single discrete
predicate — shaped like `assertKindAllowed(kind, allowedKinds)` — rather than
weaving it into the zod `.refine()` chain, so the edition check composes with it
instead of duplicating it.

**The Copilot's kind list must be a parameter, not a module constant.** §1
reduces `GOAL_KINDS` in `copilot.ts:18` to three values. Editions require the
Copilot to draft *only* entitled kinds, because a model that proposes a Quota
goal to an ARR workspace produces a dead end after the user has already been
promised something. Thread the allowed-kind list into draft generation (JSON
schema enum, prompt text, and the `copilot.ts:270` validation) rather than
reading a module-level constant. Cheap now, invasive later.

Nothing else in this spec is edition-dependent. Composition defines *what a
kind tracks*; editions define *how the platform is arranged around it*.

## 9. Program context

This spec is sub-project 1 of five. The others are explicitly out of scope.
Order below is dependency order, revised after the editions decision.

| # | Sub-project | Depends on | Status |
|---|---|---|---|
| **1** | **Per-kind composition** — this spec | — | approved |
| 2 | Widget descriptor registry + generic hardening — declarative descriptor per widget type generating both zod schemas (collapsing the `persistedSchemas` / `draftSchemas` duplication in `dashboard.ts`), the editor's config form, offerability per goal, and precondition empty-state copy; graph entrance motion; report unit formatting and axes | none | designed, not specced |
| 3 | Platform editions — `Organization.edition`, gating at goal create, template filtering, kind-specific widget gating | 1 (three kinds), 2 (registry is the gate point) | designed, not specced |
| 4 | Evidence spine — append-only `GoalEvaluation` (one row per evaluation, carrying composition fields), bucketKey-derived coverage function, sync-failure counters on `GoalMetric` | 1 (row shape) | designed, not specced |
| 5 | Per-kind surfaces — ARR waterfall, KPI funnel, quota rep table, kind-specific report sections | 1, 2, 3, 4 | not specced |

Sub-project 4 has no dependency on 2 or 3 and can run in parallel with them.

### Editions, as decided

Recorded here so the sub-project 3 spec does not re-litigate it:

- `Organization.edition` is a **real column**, not a key in the
  `settings` JSON grab-bag, because it gates pricing and routing. It is
  orthogonal to `Plan` — `Plan` sells seats, support and retention; `edition`
  sells goal kinds. `capabilitiesForPlan(plan)` becomes
  `capabilitiesFor(plan, edition)`.
- Set by the Stripe webhook from the purchased product. Trials run on `full`
  so evaluation shows the whole product; checkout narrows it. Grandfathered and
  `ENTERPRISE` workspaces are `full`.
- **Gated:** goal creation (API + Copilot draft), premade `GOAL_TEMPLATES` and
  `SEED_CATALOGUE` agent bundles, and kind-specific widgets via the sub-project
  2 registry's descriptor predicate.
- **Never gated:** the existing 12 generic widgets, and custom goals and
  dashboards within the entitled kind. Customization is not a paid axis.
- **Downgrade never strands data.** Off-edition goals keep evaluating,
  rendering and holding their widgets; they simply cannot be created or
  duplicated. Hiding a customer's live goals on a billing change is
  unacceptable in a measurement product and costs nothing to avoid.
- Four editions, no "any two" tier.

Motion in sub-project 2 follows the established `useReducedMotion()` +
`animate()` pattern from `stat-tile.tsx`; CSS-driven motion is already
neutralized under reduced-motion by `globals.css:142`.
