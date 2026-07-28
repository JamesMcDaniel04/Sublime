# Per-kind goal composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `Goal.kind` to `arr | quota | kpi` and make each kind track a composition that rolls up into the headline, with reconciliation, completeness and risk gating, so a goal's outcome is an auditable receipt rather than a status column.

**Architecture:** `evaluateGoal` is never modified — it stays the sole pure scalar evaluator. Composition is a wrapper (`evaluateComposite`) that calls it and then applies three hardcoded per-kind rollups feeding one shared reconcile/completeness/gates layer that can only ever *downgrade* risk. Components are `GoalMetric` rows (`role: 'component'` + `slot`), reusing the existing connector registry, refresh throttle and datapoint provenance. `GoalPeriod` becomes the universal settlement record for recurring *and* non-recurring goals.

**Tech Stack:** Next.js App Router, TypeScript, Prisma + Postgres, zod, `node:test` via `tsx --test`, React 19 client components, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-28-goal-kind-composition-design.md`

## Global Constraints

- Test runner is `npm test` (`tsx --test` over `src/**/__tests__/*.test.ts{,x}`). Tests use `node:test` + `node:assert/strict`, never a third-party assertion library.
- Pure logic lives in its own module with zero I/O and is unit-tested exhaustively; DB-touching code is tested only in `*-e2e.test.ts` files guarded by `if (TEST_DATABASE_URL)`.
- Every derived quantity is `null` when its inputs are absent — **never** `0`. A missing input must not read as a real measurement of nothing.
- Composition gates only ever downgrade risk. `on_track → at_risk` and `→ no_data` are legal; nothing may ever improve a risk level.
- Default reconciliation tolerance is `5` percent. Default quota coverage threshold is `3.0`. Both overridable in `Goal.composition`.
- Migration SQL is additive and idempotent-safe; each migration directory is `prisma/migrations/YYYYMMDDHHMMSS_snake_name/migration.sql` with a leading comment naming the spec.
- Uncomposed goals (`Goal.composition IS NULL`) must behave byte-identically to today. This is a tested property, not an aspiration.
- Commit after every task. Never commit a red test suite.

---

### Task 1: Legacy kind mapping (pure)

Additive only — introduces the mapping without narrowing any type, so the tree still compiles.

**Files:**
- Create: `src/lib/goals/kind-migration.ts`
- Test: `src/lib/goals/__tests__/kind-migration.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `GOAL_KIND_VALUES: readonly ['arr','quota','kpi']`, `LEGACY_KIND_MAP: Record<string, GoalKind>`, `mapLegacyKind(kind: string): GoalKind`, `type GoalKind = 'arr' | 'quota' | 'kpi'`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/kind-migration.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_KIND_VALUES,
  LEGACY_KIND_MAP,
  mapLegacyKind,
  type GoalKind,
} from '../kind-migration'

test('every legacy kind maps to a valid new kind', () => {
  for (const [legacy, next] of Object.entries(LEGACY_KIND_MAP)) {
    assert.ok(
      (GOAL_KIND_VALUES as readonly string[]).includes(next),
      `${legacy} maps to invalid kind ${next}`,
    )
  }
})

test('all seven historical kinds are covered', () => {
  for (const legacy of ['arr', 'mrr', 'revenue', 'quota', 'savings', 'lead_gen', 'custom_kpi']) {
    assert.equal(typeof mapLegacyKind(legacy), 'string', `${legacy} unmapped`)
  }
})

test('revenue family collapses to arr', () => {
  assert.equal(mapLegacyKind('arr'), 'arr')
  assert.equal(mapLegacyKind('mrr'), 'arr')
  assert.equal(mapLegacyKind('revenue'), 'arr')
})

test('quota is identity', () => {
  assert.equal(mapLegacyKind('quota'), 'quota')
})

test('savings, lead_gen and custom_kpi collapse to kpi', () => {
  assert.equal(mapLegacyKind('savings'), 'kpi')
  assert.equal(mapLegacyKind('lead_gen'), 'kpi')
  assert.equal(mapLegacyKind('custom_kpi'), 'kpi')
})

test('the three new kinds are identities', () => {
  for (const kind of GOAL_KIND_VALUES) {
    assert.equal(mapLegacyKind(kind), kind)
  }
})

test('an unknown kind falls back to kpi rather than throwing', () => {
  // A row written by a future/rogue caller must not crash the migration path.
  assert.equal(mapLegacyKind('not_a_kind'), 'kpi')
})

test('mapLegacyKind output always type-checks as GoalKind', () => {
  const result: GoalKind = mapLegacyKind('mrr')
  assert.equal(result, 'arr')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern "legacy kind" src/lib/goals/__tests__/kind-migration.test.ts`
Expected: FAIL — cannot find module `../kind-migration`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/kind-migration.ts
/**
 * Goal kind reduction (spec 2026-07-28): seven kinds collapse to three
 * product lines. The map is the single source of truth shared by the SQL
 * migration, the template remap, and any future backfill.
 *
 * Unknown kinds fall back to 'kpi' rather than throwing: 'kpi' is the
 * open-ended line whose unit the user chooses, so it is the only safe
 * destination for a value we do not recognise.
 */
export const GOAL_KIND_VALUES = ['arr', 'quota', 'kpi'] as const
export type GoalKind = (typeof GOAL_KIND_VALUES)[number]

export const LEGACY_KIND_MAP: Record<string, GoalKind> = {
  arr: 'arr',
  mrr: 'arr',
  revenue: 'arr',
  quota: 'quota',
  savings: 'kpi',
  lead_gen: 'kpi',
  custom_kpi: 'kpi',
}

export function mapLegacyKind(kind: string): GoalKind {
  return LEGACY_KIND_MAP[kind] ?? 'kpi'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/kind-migration.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/kind-migration.ts src/lib/goals/__tests__/kind-migration.test.ts
git commit -m "feat(goals): add legacy goal-kind mapping"
```

---

### Task 2: Migration — kind remap, component slots, settlement receipt

One migration carries every schema change the rest of the plan needs, so the tree is never half-migrated.

**Files:**
- Create: `prisma/migrations/20260728140000_goal_kind_composition/migration.sql`
- Modify: `prisma/schema.prisma` (models `Goal`, `GoalMetric`, `GoalPeriod`)

**Interfaces:**
- Consumes: the mapping from Task 1 (transcribed into SQL — SQL cannot import it; Task 1's test is what keeps them honest)
- Produces: columns `Goal.composition`, `Goal.compositionState`, `GoalMetric.slot`, `GoalPeriod.compositionSnapshot`, `GoalPeriod.reconciliationVariancePct`

- [ ] **Step 1: Write the migration SQL**

```sql
-- prisma/migrations/20260728140000_goal_kind_composition/migration.sql
-- Per-kind goal composition (spec 2026-07-28).
--
-- 1. Kind reduction: seven kinds collapse to arr | quota | kpi. `unit` and
--    `direction` are their own columns, so former savings (usd, decrease) and
--    lead_gen (count) rows keep their values across the remap.
UPDATE "goals" SET "kind" = CASE "kind"
  WHEN 'mrr'        THEN 'arr'
  WHEN 'revenue'    THEN 'arr'
  WHEN 'savings'    THEN 'kpi'
  WHEN 'lead_gen'   THEN 'kpi'
  WHEN 'custom_kpi' THEN 'kpi'
  ELSE "kind" END
WHERE "kind" IN ('mrr', 'revenue', 'savings', 'lead_gen', 'custom_kpi');

-- 2. Benchmark rows are DERIVED, not accumulated: aggregateGoalBenchmarks
--    regroups goals and goal_periods by kind on every Monday sweep. Rows under
--    retired keys would linger forever and never be read (surfaceGoalBenchmark
--    looks up by kind), so deleting them loses nothing.
DELETE FROM "goal_benchmarks" WHERE "kind" NOT IN ('arr', 'quota', 'kpi');

-- 3. Composition shape + the small per-evaluation summary the goals list reads
--    so it can render a composition badge without loading every component.
ALTER TABLE "goals" ADD COLUMN "composition" JSONB;
ALTER TABLE "goals" ADD COLUMN "compositionState" JSONB;

-- 4. Component slot. NULL for primary/supporting metrics; Postgres treats
--    NULLs as distinct in unique indexes, so the constraint binds only
--    component rows — one metric per slot per goal.
ALTER TABLE "goal_metrics" ADD COLUMN "slot" TEXT;
CREATE UNIQUE INDEX "goal_metrics_goalId_slot_key" ON "goal_metrics"("goalId", "slot");

-- 5. Settlement receipt. GoalPeriod becomes the universal settlement record
--    (recurring AND non-recurring), carrying what actually decided the outcome.
ALTER TABLE "goal_periods" ADD COLUMN "compositionSnapshot" JSONB;
ALTER TABLE "goal_periods" ADD COLUMN "reconciliationVariancePct" DOUBLE PRECISION;
```

- [ ] **Step 2: Mirror the columns in `prisma/schema.prisma`**

In `model Goal`, immediately after the `dashboardLayout` field:

```prisma
  /// Composition shape: the kind's declared rollup config (KPI shape, weights,
  /// per-rep targets, variance tolerance, coverage threshold). Null =
  /// uncomposed; such a goal evaluates exactly as it did before composition.
  composition      Json?
  /// Per-evaluation summary { level, boundPct, variancePct, reconciliation,
  /// breachedGates, reasons }. Written by evaluateAndPersistGoal so the goals
  /// list renders a composition badge without an N+1 over components.
  compositionState Json?
```

In `model GoalMetric`, immediately after the `role` field:

```prisma
  /// Component slot within the goal's composition — 'new_arr', 'stage:2',
  /// 'pipeline_coverage', 'driver:aws'. NULL for primary/supporting metrics;
  /// NULLs are distinct in Postgres unique indexes so they never collide.
  slot                 String?
```

and add to that model's attribute block:

```prisma
  @@unique([goalId, slot])
```

In `model GoalPeriod`, immediately after `outcome`:

```prisma
  /// Component values that decided this settlement, frozen at settlement time.
  compositionSnapshot       Json?
  /// Read-vs-derived headline variance at settlement, in percent.
  reconciliationVariancePct Float?
```

- [ ] **Step 3: Verify the schema and migration agree**

Run: `npx prisma validate && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$TEST_DATABASE_URL" --exit-code`
Expected: exit code 0 and no diff. A non-zero exit means the hand-written SQL and the schema disagree — fix the SQL, not the schema.

- [ ] **Step 4: Apply to the throwaway Postgres and confirm the remap**

Run:
```bash
npx prisma migrate deploy
psql "$TEST_DATABASE_URL" -c "SELECT DISTINCT kind FROM goals ORDER BY kind;"
```
Expected: only `arr`, `quota`, `kpi` appear (or zero rows on an empty database).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260728140000_goal_kind_composition
git commit -m "feat(goals): migrate to three kinds, component slots, settlement receipt"
```

---

### Task 3: Narrow the kind union and remap every literal

Narrowing `GoalSummary['kind']` breaks every stale literal at compile time. That is the point — the compiler enumerates the work. This task must land atomically or the tree will not build.

**Files:**
- Modify: `src/lib/types.ts` (`GoalSummary['kind']`, `GOAL_KIND_LABELS`, `GOAL_KIND_UNITS`)
- Modify: `src/lib/goals/goal-templates.ts` (46 `template(...)` entries; the `direction` and `recurrence` defaults at lines 114 and 119-121)
- Modify: `src/lib/templates/catalogue.ts` (six `goalKinds` arrays)
- Modify: `src/lib/goals/copilot.ts` (`GOAL_KINDS` at :18, `direction` inference at :353)
- Modify: `src/app/api/goals/route.ts` (`GOAL_KINDS` at :15)
- Modify: `src/lib/metrics/sources/stripe.ts:93-95`, `src/lib/metrics/sources/google-analytics.ts:75-77`, `src/lib/metrics/available-sources.ts:118`
- Modify: the 15 test files listed in Step 4

**Interfaces:**
- Consumes: `GoalKind`, `GOAL_KIND_VALUES` from Task 1
- Produces: `GoalSummary['kind']` is `GoalKind`; `GOAL_KIND_UNITS: Record<GoalKind, 'usd' | 'count' | 'percent' | null>` with `kpi: null`

- [ ] **Step 1: Narrow the type surface in `src/lib/types.ts`**

Change `GoalSummary['kind']` to reuse Task 1's union rather than restating it, and reduce the two maps:

```ts
import { type GoalKind } from '@/lib/goals/kind-migration'

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  arr: 'ARR',
  quota: 'Quota',
  kpi: 'KPI',
}

/** The kind implies the unit; only `kpi` lets the user choose (null), since it
 *  spans former savings (usd), lead_gen (count) and custom KPIs. */
export const GOAL_KIND_UNITS: Record<GoalKind, GoalSummary['unit'] | null> = {
  arr: 'usd',
  quota: 'usd',
  kpi: null,
}
```

and in `interface GoalSummary`, replace the seven-value union with `kind: GoalKind`.

- [ ] **Step 2: Run the typechecker to enumerate the breakage**

Run: `npx tsc --noEmit 2>&1 | tee /tmp/kind-errors.txt | head -60`
Expected: a list of errors, each naming a file and a stale kind literal. This list is the work queue for Steps 3-4. Do not guess at the set — read it.

- [ ] **Step 3: Remap production literals**

Apply `LEGACY_KIND_MAP` semantics at each site:

`src/lib/goals/goal-templates.ts` — remap the kind argument of all 46 `template(...)` calls (currently 33 `custom_kpi` → `kpi`, 4 `revenue` → `arr`, 4 `savings` → `kpi`, 3 `mrr` → `arr`, 3 `lead_gen` → `kpi`, 2 `quota` → `quota`, 1 `arr` → `arr`). Then fix the two defaults that lose their basis:

```ts
// was: direction: spec.direction ?? (kind === 'savings' ? 'decrease' : 'increase'),
direction: spec.direction ?? 'increase',
// was: ... : kind === 'mrr' || kind === 'lead_gen' ? 'monthly' : null,
recurrence:
  spec.recurrence !== undefined
    ? spec.recurrence
    : kind === 'quota'
      ? 'quarterly'
      : null,
```

Add `direction: 'decrease'` explicitly to the four former-`savings` templates (`engineering-org-infra-savings`, `finance-org-vendor-savings`, `finance-personal-cost-center`, and the fourth the typechecker names), and `recurrence: 'monthly'` explicitly to the three former-`mrr` and three former-`lead_gen` templates (`marketing-org-monthly-mqls`, `marketing-personal-campaign-leads`, plus the four the typechecker names).

`src/lib/templates/catalogue.ts` — remap and **dedupe** each `goalKinds` array:

```ts
goalKinds: ['arr', 'mrr', 'revenue', 'quota']  →  goalKinds: ['arr', 'quota']   // ×3
goalKinds: ['quota', 'revenue']                →  goalKinds: ['quota', 'arr']
goalKinds: ['lead_gen']                        →  goalKinds: ['kpi']
goalKinds: ['lead_gen', 'revenue']             →  goalKinds: ['kpi', 'arr']
```

`src/lib/goals/copilot.ts` — replace the `GOAL_KINDS` array at :18 with `GOAL_KIND_VALUES` imported from Task 1, and drop the `savings` direction inference at :353:

```ts
// was: direction: kind === 'savings' ? 'decrease' : data.direction,
direction: data.direction,
```

Then extend the prompt line at :131 so the model still produces decreasing cost goals now that the `savings` kind no longer implies it:

```ts
`- kind MUST be one of: ${GOAL_KINDS.join(', ')}. Pick the closest; blends use the dominant kind plus supporting metrics from other kinds.`,
'- direction is yours to choose: use "decrease" for cost, spend, churn, or cycle-time goals where a falling number is the win, and "increase" otherwise. Do not assume increase.',
```

`src/app/api/goals/route.ts:15` — replace the local `GOAL_KINDS` array with `GOAL_KIND_VALUES` from Task 1.

`src/lib/metrics/sources/stripe.ts:93-95` — the two branches were already equivalent apart from quota, so this simplifies:

```ts
availableMetrics(goalKind) {
  // Quota is tracked in a CRM, never in Stripe.
  return goalKind === 'quota' ? [] : METRICS
},
```

`src/lib/metrics/sources/google-analytics.ts:75-77` — **accepted behavior change.** `lead_gen` returned a narrowed GA4 list while `custom_kpi` returned all; both are now `kpi`, so the narrowing has no signal to key off and every KPI goal sees the full list. Template prefill still selects the correct `metricKey`, so nothing becomes unreachable — the list is just longer. Delete `LEAD_GEN_KEYS` and its filter, and leave a comment recording the trade:

```ts
// Every non-quota kind sees the full GA4 list. The former lead_gen narrowing
// died with the kind reduction (spec 2026-07-28) — lead_gen and custom_kpi
// both became 'kpi', leaving no signal to narrow on. Template prefill still
// picks the right metricKey, so the only cost is a longer picker.
availableMetrics(goalKind) {
  return goalKind === 'quota' ? [] : GA4_METRICS
},
```

`src/lib/metrics/available-sources.ts:118` — `availableMetrics('custom_kpi')` → `availableMetrics('kpi')`.

- [ ] **Step 4: Remap test literals**

These 15 files carry stale kind literals. Remap by `LEGACY_KIND_MAP`, and where a test asserts on kind-derived behavior, update the expectation too (e.g. `goal-fit.test.ts` expectations shift when `goalKinds` arrays dedupe):

```
src/app/api/__tests__/goal-agent-bundles-e2e.test.ts
src/components/goals/__tests__/agent-bundle-card.test.tsx
src/components/goals/__tests__/preview-data-widgets.test.tsx
src/lib/goals/__tests__/agent-bundle.test.ts          (13 occurrences — the heaviest)
src/lib/goals/__tests__/aggregate-benchmarks.test.ts
src/lib/goals/__tests__/copilot.test.ts
src/lib/goals/__tests__/emit-recommendation.test.ts
src/lib/goals/__tests__/goal-templates.test.ts
src/lib/goals/__tests__/goals-e2e.test.ts
src/lib/goals/__tests__/multimetric-e2e.test.ts        (kind: 'revenue' → 'arr')
src/lib/goals/__tests__/preview-data.test.ts
src/lib/goals/__tests__/recovery-candidates.test.ts
src/lib/integrations/__tests__/goals.test.ts           (kind: 'revenue' → 'arr')
src/lib/metrics/__tests__/google-analytics.test.ts
src/lib/templates/__tests__/goal-fit.test.ts
```

Two matches are **not** goal kinds and must be left alone:

- `src/lib/metrics/__tests__/assisted-sources.test.ts:39` — `name: 'revenue'` is a Slack channel name.
- Any `'revenue'` appearing as a GA4 or Stripe metric key rather than a goal kind.

In `src/lib/metrics/__tests__/google-analytics.test.ts`, the assertions at :126-131 encode the narrowing that Step 3 deleted. Replace them with one asserting the new rule:

```ts
test('every non-quota kind sees the full GA4 metric list', () => {
  for (const kind of ['arr', 'kpi']) {
    assert.equal(source.availableMetrics(kind).length, GA4_METRICS.length)
  }
  assert.deepEqual(source.availableMetrics('quota'), [])
})
```

- [ ] **Step 5: Run the full suite and typechecker**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -25`
Expected: zero type errors; all tests pass. Any remaining failure is a stale expectation, not a code defect — fix the expectation.

- [ ] **Step 6: Commit**

```bash
git add -A src/lib src/app src/components
git commit -m "refactor(goals): reduce goal kinds to arr, quota, kpi"
```

---

### Task 4: ARR rollup (pure)

**Files:**
- Create: `src/lib/goals/composition/rollup-arr.ts`
- Test: `src/lib/goals/__tests__/rollup-arr.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ARR_REQUIRED_SLOTS: readonly string[]`, `rollupArr(startValue: number, components: Map<string, number>): ArrRollup` where `ArrRollup = { derived: number | null; present: string[]; missing: string[]; netNew: number | null; nrr: number | null; grr: number | null; logoChurn: number | null }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/rollup-arr.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARR_REQUIRED_SLOTS, rollupArr } from '../composition/rollup-arr'

const full = () =>
  new Map([
    ['new_arr', 310_000],
    ['expansion_arr', 95_000],
    ['contraction_arr', 41_000],
    ['churned_arr', 130_000],
  ])

test('required slots are the four ARR movements', () => {
  assert.deepEqual([...ARR_REQUIRED_SLOTS].sort(), [
    'churned_arr',
    'contraction_arr',
    'expansion_arr',
    'new_arr',
  ])
})

test('signed sum: start + new + expansion − contraction − churn', () => {
  const r = rollupArr(2_000_000, full())
  assert.equal(r.netNew, 310_000 + 95_000 - 41_000 - 130_000)
  assert.equal(r.derived, 2_000_000 + 234_000)
  assert.deepEqual(r.missing, [])
})

test('contraction and churn are subtracted even when supplied negative', () => {
  // Some sources report churn as a negative number; magnitude is what matters.
  const m = full()
  m.set('contraction_arr', -41_000)
  m.set('churned_arr', -130_000)
  const r = rollupArr(2_000_000, m)
  assert.equal(r.derived, 2_234_000)
})

test('a missing required slot yields derived null and names the gap', () => {
  const m = full()
  m.delete('churned_arr')
  const r = rollupArr(2_000_000, m)
  assert.equal(r.derived, null)
  assert.equal(r.netNew, null)
  assert.deepEqual(r.missing, ['churned_arr'])
  assert.deepEqual(r.present.sort(), ['contraction_arr', 'expansion_arr', 'new_arr'])
})

test('all slots missing yields derived null, not zero', () => {
  const r = rollupArr(2_000_000, new Map())
  assert.equal(r.derived, null)
  assert.equal(r.present.length, 0)
  assert.equal(r.missing.length, 4)
})

test('NRR and GRR compute from the movements against startValue', () => {
  const r = rollupArr(1_000_000, full())
  // NRR = (start + expansion − contraction − churn) / start
  assert.ok(Math.abs((r.nrr ?? 0) - (1_000_000 + 95_000 - 41_000 - 130_000) / 1_000_000) < 1e-9)
  // GRR excludes expansion.
  assert.ok(Math.abs((r.grr ?? 0) - (1_000_000 - 41_000 - 130_000) / 1_000_000) < 1e-9)
})

test('NRR and GRR are null when startValue is zero, not Infinity', () => {
  const r = rollupArr(0, full())
  assert.equal(r.nrr, null)
  assert.equal(r.grr, null)
})

test('logo churn needs both customer slots', () => {
  const partial = full()
  partial.set('customers_start', 400)
  assert.equal(rollupArr(1_000_000, partial).logoChurn, null)
  partial.set('customers_churned', 12)
  assert.ok(Math.abs((rollupArr(1_000_000, partial).logoChurn ?? 0) - 0.03) < 1e-9)
})

test('logo churn is null when the starting customer count is zero', () => {
  const m = full()
  m.set('customers_start', 0)
  m.set('customers_churned', 0)
  assert.equal(rollupArr(1_000_000, m).logoChurn, null)
})

test('optional customer slots never appear in missing', () => {
  const r = rollupArr(1_000_000, full())
  assert.ok(!r.missing.includes('customers_start'))
  assert.ok(!r.missing.includes('customers_churned'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-arr.test.ts`
Expected: FAIL — cannot find module `../composition/rollup-arr`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/rollup-arr.ts
/**
 * ARR composition: a signed sum of the four movements over the period's
 * opening balance. Pure, zero I/O.
 *
 * Magnitudes, not signs, are authoritative for contraction and churn: sources
 * disagree about whether churn is reported positive or negative, and a sign
 * flip must not silently turn a loss into a gain.
 */
export const ARR_REQUIRED_SLOTS = [
  'new_arr',
  'expansion_arr',
  'contraction_arr',
  'churned_arr',
] as const

export type ArrRollup = {
  derived: number | null
  present: string[]
  missing: string[]
  netNew: number | null
  nrr: number | null
  grr: number | null
  logoChurn: number | null
}

/** Division that refuses to produce Infinity or NaN from an empty base. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function rollupArr(
  startValue: number,
  components: Map<string, number>,
): ArrRollup {
  const present = ARR_REQUIRED_SLOTS.filter((slot) => components.has(slot))
  const missing = ARR_REQUIRED_SLOTS.filter((slot) => !components.has(slot))

  const customersStart = components.get('customers_start')
  const customersChurned = components.get('customers_churned')
  const logoChurn =
    customersStart === undefined || customersChurned === undefined
      ? null
      : ratio(Math.abs(customersChurned), customersStart)

  if (missing.length > 0) {
    return {
      derived: null,
      present: [...present],
      missing: [...missing],
      netNew: null,
      nrr: null,
      grr: null,
      logoChurn,
    }
  }

  const gained =
    (components.get('new_arr') ?? 0) + (components.get('expansion_arr') ?? 0)
  const lost =
    Math.abs(components.get('contraction_arr') ?? 0) +
    Math.abs(components.get('churned_arr') ?? 0)
  const expansion = components.get('expansion_arr') ?? 0
  const netNew = gained - lost

  return {
    derived: startValue + netNew,
    present: [...present],
    missing: [],
    netNew,
    // Retention ratios describe the existing book, so new_arr is excluded.
    nrr: ratio(startValue + expansion - lost, startValue),
    grr: ratio(startValue - lost, startValue),
    logoChurn,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-arr.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/rollup-arr.ts src/lib/goals/__tests__/rollup-arr.test.ts
git commit -m "feat(goals): add ARR composition rollup"
```

---

### Task 5: Quota rollup (pure)

**Files:**
- Create: `src/lib/goals/composition/rollup-quota.ts`
- Test: `src/lib/goals/__tests__/rollup-quota.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `QUOTA_GATE_SLOTS`, `DEFAULT_COVERAGE_THRESHOLD = 3.0`, `rollupQuota(children, gates, options): QuotaRollup` where `children: Array<{ currentValue: number | null; targetValue: number }>`, `gates: Map<string, number>`, `options: { coverageThreshold?: number }`, and `QuotaRollup = { derived: number | null; attainmentPct: number | null; perRep: Array<{ currentValue: number | null; targetValue: number; attainmentPct: number | null }>; gateFindings: GateFinding[] }`, `GateFinding = { slot: string; value: number; threshold: number; breached: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/rollup-quota.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_COVERAGE_THRESHOLD,
  rollupQuota,
} from '../composition/rollup-quota'

const reps = () => [
  { currentValue: 120_000, targetValue: 200_000 },
  { currentValue: 180_000, targetValue: 200_000 },
  { currentValue: null, targetValue: 200_000 },
]

test('the default coverage threshold is 3x', () => {
  assert.equal(DEFAULT_COVERAGE_THRESHOLD, 3.0)
})

test('derived is the sum of child current values', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.equal(r.derived, 300_000)
})

test('a rep with no reading contributes nothing but still appears', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.equal(r.perRep.length, 3)
  assert.equal(r.perRep[2].currentValue, null)
  assert.equal(r.perRep[2].attainmentPct, null)
})

test('team attainment is derived over the summed targets', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.ok(Math.abs((r.attainmentPct ?? 0) - 300_000 / 600_000) < 1e-9)
})

test('no children yields derived null, not zero', () => {
  const r = rollupQuota([], new Map(), {})
  assert.equal(r.derived, null)
  assert.equal(r.attainmentPct, null)
  assert.deepEqual(r.perRep, [])
})

test('attainment is null when every target is zero', () => {
  const r = rollupQuota([{ currentValue: 10, targetValue: 0 }], new Map(), {})
  assert.equal(r.attainmentPct, null)
})

test('per-rep attainment is computed individually', () => {
  const r = rollupQuota(reps(), new Map(), {})
  assert.ok(Math.abs((r.perRep[0].attainmentPct ?? 0) - 0.6) < 1e-9)
  assert.ok(Math.abs((r.perRep[1].attainmentPct ?? 0) - 0.9) < 1e-9)
})

test('coverage below the threshold is a breached gate', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 2.1]]), {})
  const finding = r.gateFindings.find((g) => g.slot === 'pipeline_coverage')
  assert.ok(finding)
  assert.equal(finding.breached, true)
  assert.equal(finding.threshold, 3.0)
})

test('coverage at or above the threshold is not breached', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 3.0]]), {})
  assert.equal(r.gateFindings[0].breached, false)
})

test('the coverage threshold is configurable', () => {
  const r = rollupQuota(reps(), new Map([['pipeline_coverage', 2.1]]), {
    coverageThreshold: 2.0,
  })
  assert.equal(r.gateFindings[0].breached, false)
  assert.equal(r.gateFindings[0].threshold, 2.0)
})

test('an unbound gate produces no finding at all', () => {
  // Absent is not the same as breached — an unmeasured gate must not accuse.
  const r = rollupQuota(reps(), new Map(), {})
  assert.deepEqual(r.gateFindings, [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-quota.test.ts`
Expected: FAIL — cannot find module `../composition/rollup-quota`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/rollup-quota.ts
/**
 * Quota composition: team attainment is the sum of its child goals, because
 * `parentGoalId` + `ownerUserId` already model per-rep goals rolling into an
 * org goal. Component metrics on the quota goal itself carry only the leading
 * indicators that gate risk.
 *
 * An unbound gate produces no finding: absent is not breached, and an
 * unmeasured indicator must never accuse a goal.
 */
export const DEFAULT_COVERAGE_THRESHOLD = 3.0

export const QUOTA_GATE_SLOTS = [
  'pipeline_coverage',
  'win_rate',
  'avg_deal_size',
  'sales_cycle_days',
] as const

export type GateFinding = {
  slot: string
  value: number
  threshold: number
  breached: boolean
}

export type QuotaRollup = {
  derived: number | null
  attainmentPct: number | null
  perRep: Array<{
    currentValue: number | null
    targetValue: number
    attainmentPct: number | null
  }>
  gateFindings: GateFinding[]
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function rollupQuota(
  children: Array<{ currentValue: number | null; targetValue: number }>,
  gates: Map<string, number>,
  options: { coverageThreshold?: number },
): QuotaRollup {
  const threshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD

  const perRep = children.map((child) => ({
    currentValue: child.currentValue,
    targetValue: child.targetValue,
    attainmentPct:
      child.currentValue === null
        ? null
        : ratio(child.currentValue, child.targetValue),
  }))

  const gateFindings: GateFinding[] = []
  const coverage = gates.get('pipeline_coverage')
  if (coverage !== undefined) {
    gateFindings.push({
      slot: 'pipeline_coverage',
      value: coverage,
      threshold,
      breached: coverage < threshold,
    })
  }

  if (children.length === 0) {
    return { derived: null, attainmentPct: null, perRep, gateFindings }
  }

  const derived = children.reduce(
    (sum, child) => sum + (child.currentValue ?? 0),
    0,
  )
  const targetTotal = children.reduce((sum, child) => sum + child.targetValue, 0)

  return {
    derived,
    attainmentPct: ratio(derived, targetTotal),
    perRep,
    gateFindings,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-quota.test.ts`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/rollup-quota.ts src/lib/goals/__tests__/rollup-quota.test.ts
git commit -m "feat(goals): add quota composition rollup"
```

---

### Task 6: KPI rollup (pure)

**Files:**
- Create: `src/lib/goals/composition/rollup-kpi.ts`
- Test: `src/lib/goals/__tests__/rollup-kpi.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type KpiShape = 'funnel' | 'ratio' | 'weighted_sum'`, `kpiRequiredSlots(shape: KpiShape, config: KpiConfig): string[]`, `rollupKpi(shape: KpiShape, components: Map<string, number>, config: KpiConfig): KpiRollup` where `KpiConfig = { stages?: number; weights?: Record<string, number> }` and `KpiRollup = { derived: number | null; present: string[]; missing: string[]; stageConversions: Array<{ from: string; to: string; rate: number | null }> | null; driverShares: Array<{ slot: string; share: number | null }> | null }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/rollup-kpi.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kpiRequiredSlots, rollupKpi } from '../composition/rollup-kpi'

test('funnel required slots follow the declared stage count', () => {
  assert.deepEqual(kpiRequiredSlots('funnel', { stages: 3 }), [
    'stage:1',
    'stage:2',
    'stage:3',
  ])
})

test('ratio required slots are numerator and denominator', () => {
  assert.deepEqual(kpiRequiredSlots('ratio', {}), ['numerator', 'denominator'])
})

test('weighted_sum required slots come from the weight keys', () => {
  assert.deepEqual(
    kpiRequiredSlots('weighted_sum', { weights: { 'driver:aws': 1, 'driver:gcp': 2 } }).sort(),
    ['driver:aws', 'driver:gcp'],
  )
})

test('funnel derives the final stage and per-stage conversions', () => {
  const r = rollupKpi(
    'funnel',
    new Map([['stage:1', 1000], ['stage:2', 250], ['stage:3', 50]]),
    { stages: 3 },
  )
  assert.equal(r.derived, 50)
  assert.equal(r.stageConversions?.length, 2)
  assert.ok(Math.abs((r.stageConversions?.[0].rate ?? 0) - 0.25) < 1e-9)
  assert.ok(Math.abs((r.stageConversions?.[1].rate ?? 0) - 0.2) < 1e-9)
})

test('a zero upstream stage yields a null conversion, not Infinity', () => {
  const r = rollupKpi(
    'funnel',
    new Map([['stage:1', 0], ['stage:2', 0]]),
    { stages: 2 },
  )
  assert.equal(r.stageConversions?.[0].rate, null)
})

test('a missing funnel stage yields derived null', () => {
  const r = rollupKpi('funnel', new Map([['stage:1', 1000]]), { stages: 2 })
  assert.equal(r.derived, null)
  assert.deepEqual(r.missing, ['stage:2'])
})

test('ratio divides numerator by denominator', () => {
  const r = rollupKpi(
    'ratio',
    new Map([['numerator', 42], ['denominator', 168]]),
    {},
  )
  assert.ok(Math.abs((r.derived ?? 0) - 0.25) < 1e-9)
})

test('a zero denominator yields derived null', () => {
  const r = rollupKpi('ratio', new Map([['numerator', 42], ['denominator', 0]]), {})
  assert.equal(r.derived, null)
})

test('weighted_sum multiplies each driver by its weight', () => {
  const r = rollupKpi(
    'weighted_sum',
    new Map([['driver:aws', 100], ['driver:gcp', 50]]),
    { weights: { 'driver:aws': 1, 'driver:gcp': 2 } },
  )
  assert.equal(r.derived, 100 * 1 + 50 * 2)
})

test('weighted_sum reports each driver share of the total', () => {
  const r = rollupKpi(
    'weighted_sum',
    new Map([['driver:aws', 100], ['driver:gcp', 100]]),
    { weights: { 'driver:aws': 1, 'driver:gcp': 3 } },
  )
  const aws = r.driverShares?.find((d) => d.slot === 'driver:aws')
  assert.ok(Math.abs((aws?.share ?? 0) - 0.25) < 1e-9)
})

test('driver shares are null when the weighted total is zero', () => {
  const r = rollupKpi(
    'weighted_sum',
    new Map([['driver:aws', 0]]),
    { weights: { 'driver:aws': 1 } },
  )
  assert.equal(r.driverShares?.[0].share, null)
})

test('shape-irrelevant derived collections are null, not empty arrays', () => {
  // An empty array reads as "computed, found none"; null reads as "n/a here".
  const ratioRollup = rollupKpi('ratio', new Map([['numerator', 1], ['denominator', 2]]), {})
  assert.equal(ratioRollup.stageConversions, null)
  assert.equal(ratioRollup.driverShares, null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-kpi.test.ts`
Expected: FAIL — cannot find module `../composition/rollup-kpi`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/rollup-kpi.ts
/**
 * KPI composition: the only kind whose shape the user declares, because 'kpi'
 * absorbed cost trees (former savings), demand funnels (former lead_gen) and
 * arbitrary custom metrics.
 *
 * Shape-irrelevant derived collections are `null` rather than `[]`: an empty
 * array reads as "computed, found none", which is a different claim from
 * "does not apply to this shape".
 */
export type KpiShape = 'funnel' | 'ratio' | 'weighted_sum'

export type KpiConfig = {
  stages?: number
  weights?: Record<string, number>
}

export type KpiRollup = {
  derived: number | null
  present: string[]
  missing: string[]
  stageConversions: Array<{ from: string; to: string; rate: number | null }> | null
  driverShares: Array<{ slot: string; share: number | null }> | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function kpiRequiredSlots(shape: KpiShape, config: KpiConfig): string[] {
  if (shape === 'funnel') {
    const stages = Math.max(2, config.stages ?? 2)
    return Array.from({ length: stages }, (_, index) => `stage:${index + 1}`)
  }
  if (shape === 'ratio') return ['numerator', 'denominator']
  return Object.keys(config.weights ?? {})
}

export function rollupKpi(
  shape: KpiShape,
  components: Map<string, number>,
  config: KpiConfig,
): KpiRollup {
  const required = kpiRequiredSlots(shape, config)
  const present = required.filter((slot) => components.has(slot))
  const missing = required.filter((slot) => !components.has(slot))
  const incomplete = missing.length > 0

  if (shape === 'funnel') {
    const stageConversions = required.slice(0, -1).map((from, index) => {
      const to = required[index + 1]
      const upstream = components.get(from)
      const downstream = components.get(to)
      return {
        from,
        to,
        rate:
          upstream === undefined || downstream === undefined
            ? null
            : ratio(downstream, upstream),
      }
    })
    return {
      derived: incomplete ? null : (components.get(required.at(-1)!) ?? null),
      present,
      missing,
      stageConversions,
      driverShares: null,
    }
  }

  if (shape === 'ratio') {
    return {
      derived: incomplete
        ? null
        : ratio(components.get('numerator')!, components.get('denominator')!),
      present,
      missing,
      stageConversions: null,
      driverShares: null,
    }
  }

  const weights = config.weights ?? {}
  const weighted = required.map((slot) => ({
    slot,
    value: (components.get(slot) ?? 0) * (weights[slot] ?? 0),
  }))
  const total = weighted.reduce((sum, entry) => sum + entry.value, 0)
  return {
    derived: incomplete ? null : total,
    present,
    missing,
    stageConversions: null,
    driverShares: weighted.map((entry) => ({
      slot: entry.slot,
      share: ratio(entry.value, total),
    })),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/rollup-kpi.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/rollup-kpi.ts src/lib/goals/__tests__/rollup-kpi.test.ts
git commit -m "feat(goals): add KPI composition rollup"
```

---

### Task 7: Reconciliation and completeness (pure)

**Files:**
- Create: `src/lib/goals/composition/reconcile.ts`
- Create: `src/lib/goals/composition/completeness.ts`
- Test: `src/lib/goals/__tests__/reconcile.test.ts`
- Test: `src/lib/goals/__tests__/completeness.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `DEFAULT_TOLERANCE_PCT = 5`, `type ReconcileStatus = 'reconciled' | 'drifted' | 'derived_only' | 'read_only' | 'unmeasured'`, `reconcile(input: { read: number | null; derived: number | null; tolerancePct?: number }): { variancePct: number | null; status: ReconcileStatus }`, `type CompletenessLevel = 'complete' | 'partial' | 'unbound'`, `compositionCompleteness(input: { required: string[]; present: string[]; stale: string[]; errored: string[] }): { boundPct: number; missing: string[]; stale: string[]; errored: string[]; level: CompletenessLevel }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/goals/__tests__/reconcile.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TOLERANCE_PCT, reconcile } from '../composition/reconcile'

test('the default tolerance is 5 percent', () => {
  assert.equal(DEFAULT_TOLERANCE_PCT, 5)
})

test('neither number present is unmeasured', () => {
  const r = reconcile({ read: null, derived: null })
  assert.equal(r.status, 'unmeasured')
  assert.equal(r.variancePct, null)
})

test('only a read value is read_only', () => {
  const r = reconcile({ read: 100, derived: null })
  assert.equal(r.status, 'read_only')
  assert.equal(r.variancePct, null)
})

test('only a derived value is derived_only', () => {
  const r = reconcile({ read: null, derived: 100 })
  assert.equal(r.status, 'derived_only')
  assert.equal(r.variancePct, null)
})

test('a small gap reconciles and the variance is signed against the read value', () => {
  const r = reconcile({ read: 2_410_000, derived: 2_380_000 })
  assert.equal(r.status, 'reconciled')
  // Derived is below read, so variance is negative.
  assert.ok((r.variancePct ?? 0) < 0)
  assert.ok(Math.abs((r.variancePct ?? 0) + 1.2448) < 0.01)
})

test('derived above read gives a positive variance', () => {
  const r = reconcile({ read: 100, derived: 102 })
  assert.ok(Math.abs((r.variancePct ?? 0) - 2) < 1e-9)
  assert.equal(r.status, 'reconciled')
})

test('a gap beyond tolerance drifts', () => {
  const r = reconcile({ read: 100, derived: 120 })
  assert.equal(r.status, 'drifted')
  assert.ok(Math.abs((r.variancePct ?? 0) - 20) < 1e-9)
})

test('exactly at tolerance still reconciles', () => {
  const r = reconcile({ read: 100, derived: 105 })
  assert.equal(r.status, 'reconciled')
})

test('tolerance is overridable', () => {
  assert.equal(reconcile({ read: 100, derived: 120, tolerancePct: 25 }).status, 'reconciled')
  assert.equal(reconcile({ read: 100, derived: 103, tolerancePct: 1 }).status, 'drifted')
})

test('a zero read value cannot be a percentage base', () => {
  const r = reconcile({ read: 0, derived: 5 })
  assert.equal(r.variancePct, null)
  // Without a comparable base there is no drift claim to make.
  assert.equal(r.status, 'reconciled')
})
```

```ts
// src/lib/goals/__tests__/completeness.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositionCompleteness } from '../composition/completeness'

const required = ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr']

test('all slots bound and healthy is complete', () => {
  const c = compositionCompleteness({ required, present: required, stale: [], errored: [] })
  assert.equal(c.level, 'complete')
  assert.equal(c.boundPct, 100)
  assert.deepEqual(c.missing, [])
})

test('no slots bound is unbound', () => {
  const c = compositionCompleteness({ required, present: [], stale: [], errored: [] })
  assert.equal(c.level, 'unbound')
  assert.equal(c.boundPct, 0)
  assert.equal(c.missing.length, 4)
})

test('some slots bound is partial and names the gaps', () => {
  const c = compositionCompleteness({
    required,
    present: ['new_arr', 'expansion_arr'],
    stale: [],
    errored: [],
  })
  assert.equal(c.level, 'partial')
  assert.equal(c.boundPct, 50)
  assert.deepEqual(c.missing.sort(), ['churned_arr', 'contraction_arr'])
})

test('a bound-but-stale slot keeps boundPct high yet is not complete', () => {
  // Bound and readable are different claims; staleness must not hide.
  const c = compositionCompleteness({
    required,
    present: required,
    stale: ['churned_arr'],
    errored: [],
  })
  assert.equal(c.boundPct, 100)
  assert.equal(c.level, 'partial')
  assert.deepEqual(c.stale, ['churned_arr'])
})

test('a bound-but-erroring slot is not complete', () => {
  const c = compositionCompleteness({
    required,
    present: required,
    stale: [],
    errored: ['new_arr'],
  })
  assert.equal(c.level, 'partial')
  assert.deepEqual(c.errored, ['new_arr'])
})

test('an empty required set is complete rather than unbound', () => {
  // Quota requires no component slots; it must not read as broken.
  const c = compositionCompleteness({ required: [], present: [], stale: [], errored: [] })
  assert.equal(c.level, 'complete')
  assert.equal(c.boundPct, 100)
})

test('stale and errored entries outside required are ignored', () => {
  const c = compositionCompleteness({
    required,
    present: required,
    stale: ['customers_start'],
    errored: [],
  })
  assert.equal(c.level, 'complete')
  assert.deepEqual(c.stale, [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/goals/__tests__/reconcile.test.ts src/lib/goals/__tests__/completeness.test.ts`
Expected: FAIL — cannot find modules `../composition/reconcile`, `../composition/completeness`

- [ ] **Step 3: Write minimal implementations**

```ts
// src/lib/goals/composition/reconcile.ts
/**
 * Read-vs-derived reconciliation. When a headline can be read from a source
 * AND rolled up from components, the gap between them is the strongest proof
 * signal available: a composition that does not reconcile to the reported
 * number is either mis-bound or the source is wrong, and either is worth
 * saying out loud.
 *
 * A zero read value reconciles rather than drifts: with no comparable base
 * there is no percentage to compute, and accusing drift on missing
 * information would be the same error as treating an unread metric as healthy.
 */
export const DEFAULT_TOLERANCE_PCT = 5

export type ReconcileStatus =
  | 'reconciled'
  | 'drifted'
  | 'derived_only'
  | 'read_only'
  | 'unmeasured'

export function reconcile(input: {
  read: number | null
  derived: number | null
  tolerancePct?: number
}): { variancePct: number | null; status: ReconcileStatus } {
  const { read, derived } = input
  if (read === null && derived === null) {
    return { variancePct: null, status: 'unmeasured' }
  }
  if (derived === null) return { variancePct: null, status: 'read_only' }
  if (read === null) return { variancePct: null, status: 'derived_only' }
  if (read === 0) return { variancePct: null, status: 'reconciled' }

  const variancePct = ((derived - read) / Math.abs(read)) * 100
  const tolerance = input.tolerancePct ?? DEFAULT_TOLERANCE_PCT
  return {
    variancePct,
    status: Math.abs(variancePct) > tolerance ? 'drifted' : 'reconciled',
  }
}
```

```ts
// src/lib/goals/composition/completeness.ts
/**
 * How much of a composition is actually bound and readable.
 *
 * `boundPct` answers "is it wired up"; `level` answers "can it be trusted".
 * They diverge deliberately: a fully bound composition with one stale
 * component is 100% bound and still only 'partial', because bound and
 * readable are different claims.
 */
export type CompletenessLevel = 'complete' | 'partial' | 'unbound'

export function compositionCompleteness(input: {
  required: string[]
  present: string[]
  stale: string[]
  errored: string[]
}): {
  boundPct: number
  missing: string[]
  stale: string[]
  errored: string[]
  level: CompletenessLevel
} {
  const required = new Set(input.required)
  const present = input.present.filter((slot) => required.has(slot))
  const missing = input.required.filter((slot) => !input.present.includes(slot))
  // Only required slots can compromise a composition; an optional slot going
  // stale is not the goal's problem.
  const stale = input.stale.filter((slot) => required.has(slot))
  const errored = input.errored.filter((slot) => required.has(slot))

  const boundPct =
    required.size === 0 ? 100 : Math.round((present.length / required.size) * 100)

  const healthy = missing.length === 0 && stale.length === 0 && errored.length === 0
  const level: CompletenessLevel = healthy
    ? 'complete'
    : present.length === 0 && required.size > 0
      ? 'unbound'
      : 'partial'

  return { boundPct, missing, stale, errored, level }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/goals/__tests__/reconcile.test.ts src/lib/goals/__tests__/completeness.test.ts`
Expected: PASS — 10 + 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/reconcile.ts src/lib/goals/composition/completeness.ts src/lib/goals/__tests__/reconcile.test.ts src/lib/goals/__tests__/completeness.test.ts
git commit -m "feat(goals): add composition reconciliation and completeness"
```

---

### Task 8: Risk gates and the downgrade-only invariant (pure)

**Files:**
- Create: `src/lib/goals/composition/gates.ts`
- Test: `src/lib/goals/__tests__/gates.test.ts`

**Interfaces:**
- Consumes: `CompletenessLevel` and the completeness result shape (Task 7), `ReconcileStatus` (Task 7), `GateFinding` (Task 5), `GoalRiskLevel` from `src/lib/goals/evaluate.ts`
- Produces: `RISK_SEVERITY: Record<GoalRiskLevel, number>`, `applyCompositionGates(baseRisk: GoalRiskLevel, input: { completeness: CompletenessResult; reconciliation: { status: ReconcileStatus; variancePct: number | null }; gateFindings: GateFinding[] }): { riskLevel: GoalRiskLevel; reasons: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/gates.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RISK_SEVERITY, applyCompositionGates } from '../composition/gates'
import type { GoalRiskLevel } from '../evaluate'

const clean = {
  completeness: {
    boundPct: 100,
    missing: [] as string[],
    stale: [] as string[],
    errored: [] as string[],
    level: 'complete' as const,
  },
  reconciliation: { status: 'reconciled' as const, variancePct: -1.2 },
  gateFindings: [],
}

const ALL_RISKS: GoalRiskLevel[] = ['on_track', 'at_risk', 'off_track', 'no_data']

test('a clean composition never changes the base risk', () => {
  for (const base of ALL_RISKS) {
    assert.equal(applyCompositionGates(base, clean).riskLevel, base)
  }
})

test('THE INVARIANT: no condition can ever improve a risk level', () => {
  const conditions = [
    clean,
    { ...clean, completeness: { ...clean.completeness, missing: ['churned_arr'], level: 'partial' as const } },
    { ...clean, completeness: { ...clean.completeness, stale: ['new_arr'], level: 'partial' as const } },
    { ...clean, completeness: { ...clean.completeness, errored: ['new_arr'], level: 'partial' as const } },
    { ...clean, completeness: { ...clean.completeness, boundPct: 0, missing: ['a', 'b'], level: 'unbound' as const } },
    { ...clean, reconciliation: { status: 'drifted' as const, variancePct: 22 } },
    { ...clean, reconciliation: { status: 'unmeasured' as const, variancePct: null } },
    {
      ...clean,
      gateFindings: [{ slot: 'pipeline_coverage', value: 1.9, threshold: 3, breached: true }],
    },
  ]
  for (const base of ALL_RISKS) {
    for (const condition of conditions) {
      const result = applyCompositionGates(base, condition)
      assert.ok(
        RISK_SEVERITY[result.riskLevel] >= RISK_SEVERITY[base],
        `${base} improved to ${result.riskLevel}`,
      )
    }
  }
})

test('a missing required component caps an on_track goal at at_risk', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: { ...clean.completeness, missing: ['churned_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('churned_arr')))
})

test('a stale required component is no_data, not merely at_risk', () => {
  // An unread driver is unread — the same rule the headline already obeys.
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: { ...clean.completeness, stale: ['new_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'no_data')
})

test('an erroring required component is no_data', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    completeness: { ...clean.completeness, errored: ['new_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'no_data')
})

test('drifted reconciliation caps at at_risk and records the variance', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    reconciliation: { status: 'drifted', variancePct: 22.4 },
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('22.4')))
})

test('a breached leading gate caps at at_risk and names the slot', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    gateFindings: [{ slot: 'pipeline_coverage', value: 1.9, threshold: 3, breached: true }],
  })
  assert.equal(result.riskLevel, 'at_risk')
  assert.ok(result.reasons.some((r) => r.includes('pipeline_coverage')))
})

test('an unbreached gate contributes no reason', () => {
  const result = applyCompositionGates('on_track', {
    ...clean,
    gateFindings: [{ slot: 'pipeline_coverage', value: 4.2, threshold: 3, breached: false }],
  })
  assert.equal(result.riskLevel, 'on_track')
  assert.deepEqual(result.reasons, [])
})

test('the worst condition wins when several apply', () => {
  const result = applyCompositionGates('on_track', {
    completeness: {
      boundPct: 75,
      missing: ['churned_arr'],
      stale: ['new_arr'],
      errored: [],
      level: 'partial',
    },
    reconciliation: { status: 'drifted', variancePct: 30 },
    gateFindings: [{ slot: 'pipeline_coverage', value: 1, threshold: 3, breached: true }],
  })
  assert.equal(result.riskLevel, 'no_data')
  // Every applicable reason is still reported, not just the winning one.
  assert.ok(result.reasons.length >= 3)
})

test('an already off_track goal is not softened by a no_data gate', () => {
  // no_data is more severe than off_track in this ordering, so it applies.
  const result = applyCompositionGates('off_track', {
    ...clean,
    completeness: { ...clean.completeness, stale: ['new_arr'], level: 'partial' },
  })
  assert.equal(result.riskLevel, 'no_data')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/gates.test.ts`
Expected: FAIL — cannot find module `../composition/gates`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/gates.ts
/**
 * Composition risk gates. These may only ever DOWNGRADE the risk that
 * evaluateGoal computed — composition can add doubt, never confidence. The
 * invariant is enforced by taking the max severity, and is tested across
 * every (baseRisk × condition) pair.
 *
 * Severity ordering puts no_data above off_track: a number nobody can read is
 * a worse position than a number that is readably behind, because it cannot
 * be acted on. This matches evaluateGoal, which already returns no_data for a
 * stale series rather than grading it.
 */
import type { GoalRiskLevel } from '../evaluate'
import type { CompletenessLevel } from './completeness'
import type { GateFinding } from './rollup-quota'
import type { ReconcileStatus } from './reconcile'

export const RISK_SEVERITY: Record<GoalRiskLevel, number> = {
  on_track: 0,
  at_risk: 1,
  off_track: 2,
  no_data: 3,
}

type CompletenessResult = {
  boundPct: number
  missing: string[]
  stale: string[]
  errored: string[]
  level: CompletenessLevel
}

const worst = (left: GoalRiskLevel, right: GoalRiskLevel): GoalRiskLevel =>
  RISK_SEVERITY[right] > RISK_SEVERITY[left] ? right : left

export function applyCompositionGates(
  baseRisk: GoalRiskLevel,
  input: {
    completeness: CompletenessResult
    reconciliation: { status: ReconcileStatus; variancePct: number | null }
    gateFindings: GateFinding[]
  },
): { riskLevel: GoalRiskLevel; reasons: string[] } {
  const reasons: string[] = []
  let riskLevel = baseRisk

  const { missing, stale, errored } = input.completeness
  if (missing.length > 0) {
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(`Composition incomplete — not bound: ${missing.join(', ')}.`)
  }
  if (stale.length > 0) {
    riskLevel = worst(riskLevel, 'no_data')
    reasons.push(`Driver not being read — stale: ${stale.join(', ')}.`)
  }
  if (errored.length > 0) {
    riskLevel = worst(riskLevel, 'no_data')
    reasons.push(`Driver source failing: ${errored.join(', ')}.`)
  }
  if (input.reconciliation.status === 'drifted') {
    const variance = (input.reconciliation.variancePct ?? 0).toFixed(1)
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(
      `Components do not reconcile to the reported number (${variance}% variance).`,
    )
  }
  for (const finding of input.gateFindings) {
    if (!finding.breached) continue
    riskLevel = worst(riskLevel, 'at_risk')
    reasons.push(
      `${finding.slot} is ${finding.value} against a ${finding.threshold} floor.`,
    )
  }

  return { riskLevel, reasons }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/gates.test.ts`
Expected: PASS — 10 tests, including the invariant sweep over 32 pairs

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/gates.ts src/lib/goals/__tests__/gates.test.ts
git commit -m "feat(goals): add composition risk gates with downgrade-only invariant"
```

---

### Task 9: `evaluateComposite` and the no-regression lock (pure)

**Files:**
- Create: `src/lib/goals/composition/index.ts`
- Create: `src/lib/goals/composition/evaluate-composite.ts`
- Test: `src/lib/goals/__tests__/evaluate-composite.test.ts`

**Interfaces:**
- Consumes: `evaluateGoal`, `type Evaluation`, `type EvalGoal`, `type EvalPoint` from `../evaluate`; all of Tasks 4-8
- Produces: `type CompositionSpec`, `type CompositionState`, `type ComponentReading`, `parseCompositionSpec(value: unknown): CompositionSpec | null`, `evaluateComposite(input): Evaluation & { composition: CompositionState | null }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/evaluate-composite.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGoal, type EvalGoal } from '../evaluate'
import {
  evaluateComposite,
  parseCompositionSpec,
} from '../composition/evaluate-composite'

const DAY = 24 * 60 * 60 * 1000
const STALE = 2 * DAY
const t0 = new Date('2026-01-01T00:00:00Z')
const day = (n: number) => new Date(t0.getTime() + n * DAY)

const goal: EvalGoal = {
  direction: 'increase',
  startValue: 2_000_000,
  targetValue: 3_000_000,
  startAt: t0,
  targetDate: day(100),
}
const headline = [
  { value: 2_000_000, capturedAt: day(0) },
  { value: 2_500_000, capturedAt: day(49) },
]

const arrSpec = { kind: 'arr' as const }
const components = () => [
  { slot: 'new_arr', value: 310_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'expansion_arr', value: 95_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'contraction_arr', value: 41_000, capturedAt: day(49), stale: false, errored: false },
  { slot: 'churned_arr', value: 130_000, capturedAt: day(49), stale: false, errored: false },
]

test('NO REGRESSION: a null composition matches evaluateGoal exactly', () => {
  const base = evaluateGoal(goal, headline, day(50), STALE)
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: null,
    components: [],
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition, null)
  assert.deepEqual(
    {
      currentValue: composite.currentValue,
      progress: composite.progress,
      expectedProgress: composite.expectedProgress,
      projectedValue: composite.projectedValue,
      riskLevel: composite.riskLevel,
    },
    base,
  )
})

test('a complete ARR composition reconciles and leaves risk alone', () => {
  const base = evaluateGoal(goal, headline, day(50), STALE)
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: components(),
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, base.riskLevel)
  assert.equal(composite.composition?.level, 'complete')
  assert.equal(composite.composition?.reconciliation, 'reconciled')
  assert.deepEqual(composite.composition?.reasons, [])
})

test('a missing ARR component downgrades and explains itself', () => {
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: components().slice(0, 3),
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, 'at_risk')
  assert.equal(composite.composition?.level, 'partial')
  assert.ok(composite.composition?.reasons.some((r) => r.includes('churned_arr')))
})

test('a stale component makes the goal no_data', () => {
  const stale = components()
  stale[0] = { ...stale[0], stale: true }
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: stale,
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.riskLevel, 'no_data')
})

test('components that do not reconcile to the headline drift', () => {
  const drifted = components()
  drifted[0] = { ...drifted[0], value: 2_000_000 }
  const composite = evaluateComposite({
    goal,
    kind: 'arr',
    headlinePoints: headline,
    composition: arrSpec,
    components: drifted,
    children: [],
    now: day(50),
    staleAfterMs: STALE,
  })
  assert.equal(composite.composition?.reconciliation, 'drifted')
  assert.equal(composite.riskLevel, 'at_risk')
})

test('quota rolls up children and honours a custom coverage threshold', () => {
  const composite = evaluateComposite({
    goal: { ...goal, startValue: 0, targetValue: 600_000 },
    kind: 'quota',
    headlinePoints: [{ value: 300_000, capturedAt: day(49) }],
    composition: { kind: 'quota', coverageThreshold: 2.0 },
    components: [
      { slot: 'pipeline_coverage', value: 2.5, capturedAt: day(49), stale: false, errored: false },
    ],
    children: [
      { currentValue: 120_000, targetValue: 200_000 },
      { currentValue: 180_000, targetValue: 400_000 },
    ],
    now: day(50),
    staleAfterMs: STALE,
  })
  // 2.5 clears the lowered 2.0 floor, so no gate reason.
  assert.deepEqual(composite.composition?.breachedGates, [])
})

test('parseCompositionSpec rejects junk rather than throwing', () => {
  assert.equal(parseCompositionSpec(null), null)
  assert.equal(parseCompositionSpec({}), null)
  assert.equal(parseCompositionSpec({ kind: 'nope' }), null)
  assert.equal(parseCompositionSpec({ kind: 'kpi' }), null) // shape required
  assert.deepEqual(parseCompositionSpec({ kind: 'arr' }), { kind: 'arr' })
})

test('parseCompositionSpec accepts each KPI shape', () => {
  assert.ok(parseCompositionSpec({ kind: 'kpi', shape: 'ratio' }))
  assert.ok(parseCompositionSpec({ kind: 'kpi', shape: 'funnel', stages: 3 }))
  assert.ok(
    parseCompositionSpec({ kind: 'kpi', shape: 'weighted_sum', weights: { 'driver:a': 1 } }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/evaluate-composite.test.ts`
Expected: FAIL — cannot find module `../composition/evaluate-composite`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/evaluate-composite.ts
/**
 * Composite evaluation wrapper (spec 2026-07-28).
 *
 * evaluateGoal is called unchanged for the base evaluation and remains the
 * only thing that computes progress, pace, projection and base risk. This
 * wrapper then rolls up components, reconciles them against the read
 * headline, measures completeness, and applies gates that can only downgrade.
 *
 * A null composition returns the base evaluation verbatim — that property is
 * locked by test, because every goal in the database predates composition.
 */
import { z } from 'zod'
import { evaluateGoal, type EvalGoal, type EvalPoint, type Evaluation } from '../evaluate'
import type { GoalKind } from '../kind-migration'
import { ARR_REQUIRED_SLOTS, rollupArr } from './rollup-arr'
import { rollupQuota, type GateFinding } from './rollup-quota'
import { kpiRequiredSlots, rollupKpi, type KpiShape } from './rollup-kpi'
import { reconcile, type ReconcileStatus } from './reconcile'
import { compositionCompleteness, type CompletenessLevel } from './completeness'
import { applyCompositionGates } from './gates'

const compositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('arr'), tolerancePct: z.number().positive().optional() }),
  z.object({
    kind: z.literal('quota'),
    tolerancePct: z.number().positive().optional(),
    coverageThreshold: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('kpi'),
    shape: z.enum(['funnel', 'ratio', 'weighted_sum']),
    stages: z.number().int().min(2).max(10).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    tolerancePct: z.number().positive().optional(),
  }),
])

export type CompositionSpec = z.infer<typeof compositionSchema>

/** Persisted JSON is untrusted: a malformed spec degrades the goal to
 *  uncomposed rather than throwing inside a cron tick. */
export function parseCompositionSpec(value: unknown): CompositionSpec | null {
  const parsed = compositionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type ComponentReading = {
  slot: string
  value: number | null
  capturedAt: Date | null
  stale: boolean
  errored: boolean
}

export type CompositionState = {
  level: CompletenessLevel
  boundPct: number
  derived: number | null
  variancePct: number | null
  reconciliation: ReconcileStatus
  breachedGates: string[]
  missing: string[]
  reasons: string[]
}

function requiredSlotsFor(spec: CompositionSpec): string[] {
  if (spec.kind === 'arr') return [...ARR_REQUIRED_SLOTS]
  if (spec.kind === 'quota') return []
  return kpiRequiredSlots(spec.shape as KpiShape, {
    stages: spec.stages,
    weights: spec.weights,
  })
}

export function evaluateComposite(input: {
  goal: EvalGoal
  kind: GoalKind
  headlinePoints: EvalPoint[]
  composition: CompositionSpec | null
  components: ComponentReading[]
  children: Array<{ currentValue: number | null; targetValue: number }>
  now: Date
  staleAfterMs: number
}): Evaluation & { composition: CompositionState | null } {
  const base = evaluateGoal(input.goal, input.headlinePoints, input.now, input.staleAfterMs)
  const spec = input.composition
  if (!spec) return { ...base, composition: null }

  const values = new Map<string, number>()
  for (const component of input.components) {
    if (component.value !== null) values.set(component.slot, component.value)
  }

  let derived: number | null = null
  let gateFindings: GateFinding[] = []
  if (spec.kind === 'arr') {
    derived = rollupArr(input.goal.startValue, values).derived
  } else if (spec.kind === 'quota') {
    const rollup = rollupQuota(input.children, values, {
      coverageThreshold: spec.coverageThreshold,
    })
    derived = rollup.derived
    gateFindings = rollup.gateFindings
  } else {
    derived = rollupKpi(spec.shape as KpiShape, values, {
      stages: spec.stages,
      weights: spec.weights,
    }).derived
  }

  const required = requiredSlotsFor(spec)
  const completeness = compositionCompleteness({
    required,
    present: [...values.keys()],
    stale: input.components.filter((c) => c.stale).map((c) => c.slot),
    errored: input.components.filter((c) => c.errored).map((c) => c.slot),
  })
  const reconciliation = reconcile({
    read: base.currentValue,
    derived,
    tolerancePct: spec.tolerancePct,
  })
  const gated = applyCompositionGates(base.riskLevel, {
    completeness,
    reconciliation,
    gateFindings,
  })

  return {
    ...base,
    riskLevel: gated.riskLevel,
    composition: {
      level: completeness.level,
      boundPct: completeness.boundPct,
      derived,
      variancePct: reconciliation.variancePct,
      reconciliation: reconciliation.status,
      breachedGates: gateFindings.filter((g) => g.breached).map((g) => g.slot),
      missing: completeness.missing,
      reasons: gated.reasons,
    },
  }
}
```

```ts
// src/lib/goals/composition/index.ts
export { ARR_REQUIRED_SLOTS, rollupArr, type ArrRollup } from './rollup-arr'
export {
  DEFAULT_COVERAGE_THRESHOLD,
  QUOTA_GATE_SLOTS,
  rollupQuota,
  type GateFinding,
  type QuotaRollup,
} from './rollup-quota'
export {
  kpiRequiredSlots,
  rollupKpi,
  type KpiConfig,
  type KpiRollup,
  type KpiShape,
} from './rollup-kpi'
export { DEFAULT_TOLERANCE_PCT, reconcile, type ReconcileStatus } from './reconcile'
export { compositionCompleteness, type CompletenessLevel } from './completeness'
export { RISK_SEVERITY, applyCompositionGates } from './gates'
export {
  evaluateComposite,
  parseCompositionSpec,
  type ComponentReading,
  type CompositionSpec,
  type CompositionState,
} from './evaluate-composite'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/goals/__tests__/evaluate-composite.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/composition/evaluate-composite.ts src/lib/goals/composition/index.ts src/lib/goals/__tests__/evaluate-composite.test.ts
git commit -m "feat(goals): add evaluateComposite with no-regression lock"
```

---

### Task 10: Wire composition into the refresh tick

**Files:**
- Modify: `src/lib/goals/refresh.ts` (`evaluateAndPersistGoal`, around :144-168 and :300-340)
- Test: `src/lib/goals/__tests__/composition-e2e.test.ts` (created here, extended in Task 14)

**Interfaces:**
- Consumes: `evaluateComposite`, `parseCompositionSpec`, `type ComponentReading` (Task 9)
- Produces: `evaluateAndPersistGoal` persists `Goal.compositionState`; unchanged signature `(goalId, organizationId, now?) => Promise<boolean>`

- [ ] **Step 1: Load components and children in `evaluateAndPersistGoal`**

Widen the `include` in the `prisma.goal.findFirst` call so components arrive with the goal, and add the child-goal read that quota needs. Replace the existing `metrics` include block with:

```ts
      metrics: {
        where: { role: { in: ['primary', 'component'] } },
        select: {
          id: true,
          role: true,
          slot: true,
          refreshIntervalHours: true,
          lastError: true,
        },
      },
      children: {
        select: { id: true, targetValue: true },
      },
```

and derive the primary from that list rather than assuming index 0:

```ts
  const metric = goal.metrics.find((entry) => entry.role === 'primary') ?? null
  const componentMetrics = goal.metrics.filter((entry) => entry.role === 'component')
```

- [ ] **Step 2: Read the latest reading per component**

Insert after the existing `descending` datapoint read. One query for all components, not one per component:

```ts
  // Latest reading per component in a single pass. Components are few (the
  // create route caps a goal at 12 metrics), so ordering in SQL and taking the
  // first per metric in memory is cheaper than a query per slot.
  const componentReadings: ComponentReading[] = []
  if (componentMetrics.length > 0) {
    const rows = await prisma.metricDatapoint.findMany({
      where: {
        organizationId,
        goalMetricId: { in: componentMetrics.map((entry) => entry.id) },
      },
      orderBy: { capturedAt: 'desc' },
      select: { goalMetricId: true, value: true, capturedAt: true },
    })
    const latest = new Map<string, { value: number; capturedAt: Date }>()
    for (const row of rows) {
      if (!latest.has(row.goalMetricId)) {
        latest.set(row.goalMetricId, { value: row.value, capturedAt: row.capturedAt })
      }
    }
    for (const entry of componentMetrics) {
      if (!entry.slot) continue
      const reading = latest.get(entry.id) ?? null
      const componentStaleMs = 2 * entry.refreshIntervalHours * HOUR_MS
      componentReadings.push({
        slot: entry.slot,
        value: reading?.value ?? null,
        capturedAt: reading?.capturedAt ?? null,
        // A component with no reading at all is *missing*, not stale — the
        // completeness layer distinguishes them and they gate differently.
        stale:
          reading !== null &&
          now.getTime() - reading.capturedAt.getTime() > componentStaleMs,
        errored: Boolean(entry.lastError),
      })
    }
  }
```

- [ ] **Step 3: Swap `evaluateGoal` for `evaluateComposite` and persist the state**

Replace the `const evaluated = evaluateGoal(...)` call near :306 with:

```ts
  const compositionSpec = parseCompositionSpec(goal.composition)
  const evaluatedComposite = evaluateComposite({
    goal: { ...goal, direction: goal.direction as 'increase' | 'decrease' },
    kind: goal.kind as GoalKind,
    headlinePoints: evaluationPoints,
    composition: compositionSpec,
    components: componentReadings,
    children: goal.children.map((child) => ({
      // A child's current value is its own latest primary reading, already
      // persisted on the child row by its own evaluation pass.
      currentValue: child.currentValue ?? null,
      targetValue: child.targetValue,
    })),
    now,
    staleAfterMs,
  })
  const { composition: compositionState, ...evaluated } = evaluatedComposite
```

Then extend the persisting `prisma.goal.update` near :327 to write the summary:

```ts
    data: {
      riskLevel: evaluation.riskLevel,
      lastEvaluatedAt: now,
      compositionState: (compositionState ?? null) as never,
      ...(settled && goal.status === 'active' ? { status: settled } : {}),
    },
```

> **Note on `child.currentValue`:** `Goal` has no `currentValue` column — it is computed per evaluation. Add `currentValue` to the child select only if a later task introduces the column; until then, read each child's latest primary datapoint with the same single-query pattern as Step 2, keyed on the children's primary metric ids. Implement that read now rather than leaving `currentValue` undefined, or quota rollup will always see `null` children.

- [ ] **Step 4: Write the composition e2e test**

```ts
// src/lib/goals/__tests__/composition-e2e.test.ts
/**
 * ARR composition against the throwaway Postgres: create a composed goal,
 * seed component readings, evaluate, and assert gating plus the settlement
 * receipt. Skipped unless TEST_DATABASE_URL is present.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let goalId = ''
  const slots = ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr']
  const componentIds: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seeded } = await import('./helpers/seed'))
    const org = await seeded()
    const goal = await prisma.goal.create({
      data: {
        organizationId: org.organizationId,
        name: 'ARR to 3M',
        kind: 'arr',
        direction: 'increase',
        unit: 'usd',
        startValue: 2_000_000,
        targetValue: 3_000_000,
        targetDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        createdByUserId: org.userId,
        composition: { kind: 'arr' },
      },
    })
    goalId = goal.id
    const primary = await prisma.goalMetric.create({
      data: {
        organizationId: org.organizationId,
        goalId,
        role: 'primary',
        source: 'manual',
        metricKey: 'manual.value',
        config: {},
      },
    })
    await prisma.metricDatapoint.create({
      data: {
        organizationId: org.organizationId,
        goalMetricId: primary.id,
        value: 2_234_000,
        capturedAt: new Date(),
        bucketKey: new Date().toISOString().slice(0, 10),
        origin: 'manual',
      },
    })
    for (const slot of slots) {
      const row = await prisma.goalMetric.create({
        data: {
          organizationId: org.organizationId,
          goalId,
          role: 'component',
          slot,
          source: 'manual',
          metricKey: 'manual.value',
          config: {},
        },
      })
      componentIds[slot] = row.id
    }
  })

  after(async () => {
    await prisma.$disconnect()
  })

  test('an unbound composition gates the goal at at_risk', async () => {
    const { evaluateAndPersistGoal } = await import('../refresh')
    const goal = await prisma.goal.findUnique({ where: { id: goalId } })
    await evaluateAndPersistGoal(goalId, goal.organizationId)
    const after = await prisma.goal.findUnique({ where: { id: goalId } })
    assert.equal(after.riskLevel, 'at_risk')
    assert.equal(after.compositionState.level, 'unbound')
    assert.equal(after.compositionState.missing.length, 4)
  })

  test('a complete, reconciling composition clears the gate', async () => {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } })
    const values: Record<string, number> = {
      new_arr: 310_000,
      expansion_arr: 95_000,
      contraction_arr: 41_000,
      churned_arr: 130_000,
    }
    const now = new Date()
    for (const slot of slots) {
      await prisma.metricDatapoint.create({
        data: {
          organizationId: goal.organizationId,
          goalMetricId: componentIds[slot],
          value: values[slot],
          capturedAt: now,
          bucketKey: now.toISOString().slice(0, 10),
          origin: 'manual',
        },
      })
    }
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, goal.organizationId)
    const after = await prisma.goal.findUnique({ where: { id: goalId } })
    // Components sum to 2,234,000 — exactly the read headline.
    assert.equal(after.compositionState.level, 'complete')
    assert.equal(after.compositionState.reconciliation, 'reconciled')
    assert.deepEqual(after.compositionState.reasons, [])
  })

  test('drifting a component downgrades to at_risk with a reason', async () => {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } })
    const now = new Date()
    await prisma.metricDatapoint.update({
      where: {
        goalMetricId_bucketKey: {
          goalMetricId: componentIds.new_arr,
          bucketKey: now.toISOString().slice(0, 10),
        },
      },
      data: { value: 900_000 },
    })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, goal.organizationId)
    const after = await prisma.goal.findUnique({ where: { id: goalId } })
    assert.equal(after.compositionState.reconciliation, 'drifted')
    assert.equal(after.riskLevel, 'at_risk')
    assert.ok(
      after.compositionState.reasons.some((reason: string) =>
        reason.includes('reconcile'),
      ),
    )
  })
}
```

> If `./helpers/seed` does not exist, copy the seeding preamble from `src/lib/goals/__tests__/multimetric-e2e.test.ts` inline rather than inventing a helper module.

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/goals/__tests__/composition-e2e.test.ts src/lib/goals/__tests__/evaluate.test.ts src/lib/goals/__tests__/goals-e2e.test.ts src/lib/goals/__tests__/multimetric-e2e.test.ts`
Expected: PASS. The existing `evaluate` and `goals-e2e` suites passing unchanged is the regression signal that uncomposed goals still behave identically.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/refresh.ts src/lib/goals/__tests__/composition-e2e.test.ts
git commit -m "feat(goals): evaluate composition in the refresh tick"
```

---

### Task 11: Universal settlement receipt

**Files:**
- Modify: `src/lib/goals/refresh.ts` (the recurring settlement transaction near :230-254, and the non-recurring settle branch near :320-334)
- Test: `src/lib/goals/__tests__/composition-e2e.test.ts` (append)

**Interfaces:**
- Consumes: `CompositionState` (Task 9)
- Produces: a `GoalPeriod` row on every settlement, recurring or not, carrying `compositionSnapshot` and `reconciliationVariancePct`

- [ ] **Step 1: Write the failing test (append to `composition-e2e.test.ts`)**

```ts
  test('a non-recurring goal writes a GoalPeriod receipt when it settles', async () => {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } })
    // Push the deadline into the past so settleStatus fires, and make the
    // headline clear the target so the outcome is 'achieved'.
    await prisma.goal.update({
      where: { id: goalId },
      data: {
        targetDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        targetValue: 2_000_000,
      },
    })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, goal.organizationId)

    const after = await prisma.goal.findUnique({ where: { id: goalId } })
    assert.equal(after.status, 'achieved')

    const periods = await prisma.goalPeriod.findMany({ where: { goalId } })
    assert.equal(periods.length, 1, 'exactly one settlement receipt')
    const receipt = periods[0]
    assert.equal(receipt.outcome, 'achieved')
    assert.equal(receipt.targetValue, 2_000_000)
    assert.ok(receipt.finalValue > 0, 'records the value that decided it')
    assert.ok(receipt.compositionSnapshot, 'records the components')
    assert.equal(typeof receipt.reconciliationVariancePct, 'number')
  })

  test('settling twice does not write a second receipt', async () => {
    const goal = await prisma.goal.findUnique({ where: { id: goalId } })
    const { evaluateAndPersistGoal } = await import('../refresh')
    await evaluateAndPersistGoal(goalId, goal.organizationId)
    const periods = await prisma.goalPeriod.findMany({ where: { goalId } })
    assert.equal(periods.length, 1, 'settlement is idempotent')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test --test-name-pattern "receipt" src/lib/goals/__tests__/composition-e2e.test.ts`
Expected: FAIL — `periods.length` is 0, because non-recurring goals never write a period today.

- [ ] **Step 3: Write the settlement receipt**

In `evaluateAndPersistGoal`, replace the settle-persisting `prisma.goal.update` with a transaction that writes the receipt alongside the status change. Guard on the status transition so a second tick is a no-op:

```ts
  const settling = Boolean(settled) && goal.status === 'active'
  await prisma.$transaction(async (tx) => {
    await tx.goal.update({
      where: { id: goal.id, organizationId },
      data: {
        riskLevel: evaluation.riskLevel,
        lastEvaluatedAt: now,
        compositionState: (compositionState ?? null) as never,
        ...(settling ? { status: settled! } : {}),
      },
    })
    // Universal settlement receipt (spec 2026-07-28 §5): recurring goals get
    // one per rollover already; this covers the non-recurring case, which
    // previously flipped a status column with no record of what decided it.
    // Gated on `settling` — the status transition — so a later tick on an
    // already-settled goal cannot write a duplicate.
    if (settling) {
      await tx.goalPeriod.create({
        data: {
          organizationId,
          goalId: goal.id,
          periodStart: goal.startAt,
          periodEnd: goal.targetDate,
          startValue: goal.startValue,
          targetValue: goal.targetValue,
          finalValue: evaluation.currentValue ?? goal.startValue,
          outcome: settled!,
          compositionSnapshot: componentReadings.length
            ? (componentReadings.map((reading) => ({
                slot: reading.slot,
                value: reading.value,
                capturedAt: reading.capturedAt?.toISOString() ?? null,
                stale: reading.stale,
                errored: reading.errored,
              })) as never)
            : undefined,
          reconciliationVariancePct: compositionState?.variancePct ?? undefined,
        },
      })
    }
  })
```

Then add the same two fields to the **recurring** rollover's `tx.goalPeriod.create` near :231 so both settlement paths produce the same shape of receipt:

```ts
          compositionSnapshot: componentReadings.length
            ? (componentReadings.map((reading) => ({
                slot: reading.slot,
                value: reading.value,
                capturedAt: reading.capturedAt?.toISOString() ?? null,
                stale: reading.stale,
                errored: reading.errored,
              })) as never)
            : undefined,
          reconciliationVariancePct: compositionState?.variancePct ?? undefined,
```

> The recurring path computes its period *before* the final evaluation, so `compositionState` is not yet assigned there. Move the component read (Task 10 Step 2) above the rollover loop so both paths can see `componentReadings`, and pass `undefined` for `reconciliationVariancePct` in the rollover rather than reordering the evaluation.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npx tsx --test src/lib/goals/__tests__/composition-e2e.test.ts src/lib/goals/__tests__/recurrence.test.ts src/lib/goals/__tests__/goals-e2e.test.ts`
Expected: PASS — including both new receipt tests and the untouched recurrence suite.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/refresh.ts src/lib/goals/__tests__/composition-e2e.test.ts
git commit -m "feat(goals): write a settlement receipt for every settled goal"
```

---

### Task 12: Accept components at the API, behind a kind seam

**Files:**
- Modify: `src/app/api/goals/route.ts` (metric schema :36, cap :62, refines :66-95, persistence :258-275)
- Modify: `src/app/api/goals/[id]/route.ts` (PATCH — accept `composition`)
- Create: `src/lib/goals/composition/presets.ts`
- Test: `src/lib/goals/__tests__/composition-presets.test.ts`

**Interfaces:**
- Consumes: `GoalKind` (Task 1), `ARR_REQUIRED_SLOTS` / `kpiRequiredSlots` / `parseCompositionSpec` (Tasks 4, 6, 9)
- Produces: `assertKindAllowed(kind: GoalKind, allowedKinds: readonly GoalKind[]): string | null`, `validateComposition(kind: GoalKind, composition: unknown, slots: string[]): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/composition-presets.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertKindAllowed, validateComposition } from '../composition/presets'

test('an allowed kind passes', () => {
  assert.equal(assertKindAllowed('arr', ['arr', 'quota', 'kpi']), null)
})

test('a disallowed kind returns a message naming what is available', () => {
  const message = assertKindAllowed('quota', ['arr'])
  assert.ok(message)
  assert.ok(message.includes('quota'))
  assert.ok(message.includes('arr'))
})

test('a null composition is always valid — composition is opt-in', () => {
  assert.equal(validateComposition('arr', null, []), null)
})

test('an ARR composition requires all four movement slots', () => {
  const message = validateComposition('arr', { kind: 'arr' }, ['new_arr'])
  assert.ok(message)
  assert.ok(message.includes('churned_arr'))
})

test('an ARR composition with all four slots is valid', () => {
  assert.equal(
    validateComposition('arr', { kind: 'arr' }, [
      'new_arr',
      'expansion_arr',
      'contraction_arr',
      'churned_arr',
    ]),
    null,
  )
})

test('the composition kind must match the goal kind', () => {
  const message = validateComposition('arr', { kind: 'quota' }, [])
  assert.ok(message)
  assert.ok(message.includes('match'))
})

test('a malformed composition is rejected with a message, not silently dropped', () => {
  assert.ok(validateComposition('kpi', { kind: 'kpi' }, []))
  assert.ok(validateComposition('arr', { nonsense: true }, []))
})

test('a KPI ratio composition requires numerator and denominator', () => {
  assert.ok(validateComposition('kpi', { kind: 'kpi', shape: 'ratio' }, ['numerator']))
  assert.equal(
    validateComposition('kpi', { kind: 'kpi', shape: 'ratio' }, ['numerator', 'denominator']),
    null,
  )
})

test('a quota composition needs no component slots', () => {
  assert.equal(validateComposition('quota', { kind: 'quota' }, []), null)
})

test('unknown slots are rejected so a typo is not silently inert', () => {
  const message = validateComposition(
    'arr',
    { kind: 'arr' },
    ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr', 'nwe_arr'],
  )
  assert.ok(message)
  assert.ok(message.includes('nwe_arr'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/goals/__tests__/composition-presets.test.ts`
Expected: FAIL — cannot find module `../composition/presets`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/goals/composition/presets.ts
/**
 * Per-kind composition validation, and the entitlement seam.
 *
 * assertKindAllowed is deliberately a discrete predicate rather than a zod
 * refine: the platform-editions work (spec §8) gates creatable kinds at
 * exactly this point, and it must compose with kind validation rather than
 * duplicate it.
 */
import type { GoalKind } from '../kind-migration'
import { ARR_REQUIRED_SLOTS } from './rollup-arr'
import { QUOTA_GATE_SLOTS } from './rollup-quota'
import { kpiRequiredSlots, type KpiShape } from './rollup-kpi'
import { parseCompositionSpec } from './evaluate-composite'

export function assertKindAllowed(
  kind: GoalKind,
  allowedKinds: readonly GoalKind[],
): string | null {
  if (allowedKinds.includes(kind)) return null
  return `This workspace cannot create ${kind} goals. Available: ${allowedKinds.join(', ')}.`
}

const OPTIONAL_SLOTS: Record<GoalKind, readonly string[]> = {
  arr: ['customers_start', 'customers_churned'],
  quota: QUOTA_GATE_SLOTS,
  kpi: [],
}

export function validateComposition(
  kind: GoalKind,
  composition: unknown,
  slots: string[],
): string | null {
  if (composition === null || composition === undefined) return null

  const spec = parseCompositionSpec(composition)
  if (!spec) return 'That composition is not a shape this goal kind understands.'
  if (spec.kind !== kind) {
    return `The composition kind (${spec.kind}) must match the goal kind (${kind}).`
  }

  const required =
    spec.kind === 'arr'
      ? [...ARR_REQUIRED_SLOTS]
      : spec.kind === 'quota'
        ? []
        : kpiRequiredSlots(spec.shape as KpiShape, {
            stages: spec.stages,
            weights: spec.weights,
          })

  const missing = required.filter((slot) => !slots.includes(slot))
  if (missing.length > 0) {
    return `Bind a source for: ${missing.join(', ')}.`
  }

  // A slot outside the vocabulary would never be read by any rollup, so it
  // would sit inert and invisible. Reject it as the typo it almost certainly is.
  const known = new Set([...required, ...OPTIONAL_SLOTS[kind]])
  const unknown = slots.filter((slot) => !known.has(slot))
  if (unknown.length > 0) {
    return `Not a ${kind} component: ${unknown.join(', ')}.`
  }

  return null
}
```

- [ ] **Step 4: Wire it into the create route**

In `src/app/api/goals/route.ts`:

Widen the metric schema at :36 and add `slot`:

```ts
  role: z.enum(['primary', 'supporting', 'component']),
  slot: z.string().min(1).max(64).optional(),
```

Raise the cap at :62 from `.max(4)` to `.max(12)`, and accept a composition on the body:

```ts
    composition: z.unknown().optional(),
```

Add two refines after the existing "exactly one primary" refine:

```ts
  .refine(
    (body) => !body.metrics || body.metrics.every(
      (metric) => (metric.role === 'component') === (metric.slot !== undefined),
    ),
    { message: 'Component metrics need a slot; primary and supporting must not have one.' },
  )
  .superRefine((body, ctx) => {
    const slots = (body.metrics ?? [])
      .filter((metric) => metric.role === 'component')
      .map((metric) => metric.slot!)
    const message = validateComposition(body.kind, body.composition ?? null, slots)
    if (message) ctx.addIssue({ code: 'custom', path: ['composition'], message })
  })
```

Persist `slot` and `composition` — in the `tx.goal.create` data block add:

```ts
        composition: (input.composition ?? null) as never,
```

and in the `tx.goalMetric.create` data block add:

```ts
          slot: metric.slot ?? null,
```

In `src/app/api/goals/[id]/route.ts`'s PATCH schema, accept `composition: z.unknown().optional()` and validate it through `validateComposition` against the goal's existing component slots before persisting.

- [ ] **Step 5: Run tests**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -20`
Expected: PASS — 10 new preset tests plus the whole existing suite.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/composition/presets.ts src/lib/goals/__tests__/composition-presets.test.ts src/app/api/goals/route.ts "src/app/api/goals/[id]/route.ts"
git commit -m "feat(goals): accept component metrics and composition at the API"
```

---

### Task 13: Copilot drafts components against a parameterised kind list

**Files:**
- Modify: `src/lib/goals/copilot.ts` (`GOAL_KINDS` :18, JSON schema :57 and :86, prompt :131, zod :202, validation :270, mapping :314-319)
- Test: `src/lib/goals/__tests__/copilot-schema.test.ts` (extend)

**Interfaces:**
- Consumes: `GOAL_KIND_VALUES`, `GoalKind` (Task 1)
- Produces: draft functions take `allowedKinds: readonly GoalKind[]` and never emit a kind outside it

- [ ] **Step 1: Write the failing test (append to `copilot-schema.test.ts`)**

```ts
test('the draft schema only offers the allowed kinds', async () => {
  const { goalDraftJsonSchema } = await import('../copilot')
  const schema = goalDraftJsonSchema(['arr'])
  assert.deepEqual(schema.properties.kind.enum, ['arr'])
})

test('the draft prompt names only the allowed kinds', async () => {
  const { goalDraftPrompt } = await import('../copilot')
  const prompt = goalDraftPrompt(['arr', 'kpi'])
  assert.ok(prompt.includes('arr'))
  assert.ok(prompt.includes('kpi'))
  assert.ok(!prompt.includes('quota'))
})

test('a draft naming a disallowed kind is rejected', async () => {
  const { validateGoalDraft } = await import('../copilot')
  const result = validateGoalDraft({ kind: 'quota', name: 'x' }, ['arr'])
  assert.ok(result.error)
})

test('component metrics may carry a slot', async () => {
  const { goalDraftJsonSchema } = await import('../copilot')
  const schema = goalDraftJsonSchema(['arr'])
  const metric = schema.properties.metrics.items.properties
  assert.deepEqual(metric.role.enum, ['primary', 'supporting', 'component'])
  assert.equal(metric.slot.type, 'string')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern "allowed kinds" src/lib/goals/__tests__/copilot-schema.test.ts`
Expected: FAIL — `goalDraftJsonSchema` is not exported, or does not take an argument.

- [ ] **Step 3: Thread the kind list through**

Convert the module-level `GOAL_KINDS` constant into a default and make each consumer take the list as a parameter. Where the JSON schema is currently built inline, extract it:

```ts
export function goalDraftJsonSchema(allowedKinds: readonly GoalKind[] = GOAL_KIND_VALUES) {
  return {
    // ...existing schema...
    properties: {
      // ...
      kind: { type: 'string', enum: [...allowedKinds] },
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            // ...
            role: { type: 'string', enum: ['primary', 'supporting', 'component'] },
            slot: { type: 'string' },
          },
        },
      },
    },
  }
}

export function goalDraftPrompt(allowedKinds: readonly GoalKind[] = GOAL_KIND_VALUES) {
  return [
    // ...existing lines...
    `- kind MUST be one of: ${allowedKinds.join(', ')}. Pick the closest.`,
    '- direction is yours to choose: use "decrease" for cost, spend, churn, or cycle-time goals where a falling number is the win, and "increase" otherwise.',
    '- For an arr goal, propose four component metrics with slots new_arr, expansion_arr, contraction_arr and churned_arr so the headline can be reconciled against its drivers.',
  ].join('\n')
}
```

Widen the zod role at :202 to `z.enum(['primary', 'supporting', 'component'])`, add `slot: z.string().min(1).max(64).optional()`, and change the validation at :270 to check against the passed list rather than the module constant. Update the inline union at :217 to the three roles.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npx tsx --test src/lib/goals/__tests__/copilot-schema.test.ts src/lib/goals/__tests__/copilot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/copilot.ts src/lib/goals/__tests__/copilot-schema.test.ts
git commit -m "feat(goals): parameterise Copilot goal kinds and draft components"
```

---

### Task 14: Component binding UI

**Files:**
- Modify: `src/components/goals/metric-binding-fields.tsx` (`MetricBinding` type)
- Create: `src/components/goals/composition-fields.tsx`
- Modify: `src/app/goals/new/page.tsx` (render the component section for the chosen kind)
- Test: `src/components/goals/__tests__/composition-fields.test.tsx`

**Interfaces:**
- Consumes: `MetricBinding`, `MetricBindingFields`, `metricBindingIssue` (existing); `ARR_REQUIRED_SLOTS`, `kpiRequiredSlots`, `QUOTA_GATE_SLOTS` (Tasks 4-6)
- Produces: `SLOT_LABELS: Record<string, string>`, `slotsForKind(kind: GoalKind, shape?: KpiShape, stages?: number): Array<{ slot: string; required: boolean }>`, `<CompositionFields kind bindings onChange />`

- [ ] **Step 1: Widen `MetricBinding`**

```ts
export type MetricBinding = {
  label: string
  role: 'primary' | 'supporting' | 'component'
  /** Set only when role is 'component'. */
  slot?: string
  source: string
  metricKey: string
  unit: 'usd' | 'count' | 'percent'
  connectionRef: string | null
  config: Record<string, unknown>
}
```

In `metricBindingIssue`, the `role` now appears in user-facing copy (`Name the ${binding.role} series.`), which would read "Name the component series." Make it read the slot label when present:

```ts
  const noun = binding.role === 'component' && binding.slot
    ? (SLOT_LABELS[binding.slot] ?? binding.slot)
    : `${binding.role} series`
  if (!binding.label.trim()) return `Name the ${noun}.`
```

- [ ] **Step 2: Write the failing test**

```tsx
// src/components/goals/__tests__/composition-fields.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SLOT_LABELS, slotsForKind } from '../composition-fields'

test('ARR offers the four movements as required', () => {
  const slots = slotsForKind('arr')
  const required = slots.filter((entry) => entry.required).map((entry) => entry.slot)
  assert.deepEqual(required.sort(), [
    'churned_arr',
    'contraction_arr',
    'expansion_arr',
    'new_arr',
  ])
})

test('ARR also offers the optional customer-count slots', () => {
  const optional = slotsForKind('arr').filter((entry) => !entry.required)
  assert.deepEqual(optional.map((entry) => entry.slot).sort(), [
    'customers_churned',
    'customers_start',
  ])
})

test('quota offers only optional leading indicators', () => {
  const slots = slotsForKind('quota')
  assert.ok(slots.length > 0)
  assert.ok(slots.every((entry) => !entry.required))
})

test('a KPI funnel offers one slot per declared stage', () => {
  assert.deepEqual(
    slotsForKind('kpi', 'funnel', 3).map((entry) => entry.slot),
    ['stage:1', 'stage:2', 'stage:3'],
  )
})

test('a KPI ratio offers numerator and denominator, both required', () => {
  const slots = slotsForKind('kpi', 'ratio')
  assert.deepEqual(slots.map((entry) => entry.slot), ['numerator', 'denominator'])
  assert.ok(slots.every((entry) => entry.required))
})

test('every offered slot has human copy', () => {
  for (const kind of ['arr', 'quota'] as const) {
    for (const entry of slotsForKind(kind)) {
      assert.ok(SLOT_LABELS[entry.slot], `${entry.slot} has no label`)
    }
  }
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test src/components/goals/__tests__/composition-fields.test.tsx`
Expected: FAIL — cannot find module `../composition-fields`

- [ ] **Step 4: Implement `composition-fields.tsx`**

```tsx
'use client'

/**
 * Per-slot component binding. A component is the same source-binding control
 * the wizard already uses for primary and supporting metrics, rendered once
 * per slot in the kind's vocabulary — so every connector, config validator and
 * connect-dialog behaviour comes along for free.
 */
import { ARR_REQUIRED_SLOTS } from '@/lib/goals/composition/rollup-arr'
import { QUOTA_GATE_SLOTS } from '@/lib/goals/composition/rollup-quota'
import { kpiRequiredSlots, type KpiShape } from '@/lib/goals/composition/rollup-kpi'
import type { GoalKind } from '@/lib/goals/kind-migration'
import { MetricBindingFields, type MetricBinding } from './metric-binding-fields'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

export const SLOT_LABELS: Record<string, string> = {
  new_arr: 'New ARR',
  expansion_arr: 'Expansion ARR',
  contraction_arr: 'Contraction ARR',
  churned_arr: 'Churned ARR',
  customers_start: 'Customers at period start',
  customers_churned: 'Customers churned',
  pipeline_coverage: 'Pipeline coverage ratio',
  win_rate: 'Win rate',
  avg_deal_size: 'Average deal size',
  sales_cycle_days: 'Sales cycle (days)',
  numerator: 'Numerator',
  denominator: 'Denominator',
}

export function slotsForKind(
  kind: GoalKind,
  shape?: KpiShape,
  stages?: number,
): Array<{ slot: string; required: boolean }> {
  if (kind === 'arr') {
    return [
      ...ARR_REQUIRED_SLOTS.map((slot) => ({ slot, required: true })),
      { slot: 'customers_start', required: false },
      { slot: 'customers_churned', required: false },
    ]
  }
  if (kind === 'quota') {
    return QUOTA_GATE_SLOTS.map((slot) => ({ slot, required: false }))
  }
  if (!shape) return []
  return kpiRequiredSlots(shape, { stages }).map((slot) => ({ slot, required: true }))
}

export function CompositionFields({
  kind,
  shape,
  stages,
  bindings,
  sources,
  onChange,
}: {
  kind: GoalKind
  shape?: KpiShape
  stages?: number
  bindings: MetricBinding[]
  sources: MetricSourceOption[]
  onChange: (next: MetricBinding[]) => void
}) {
  const slots = slotsForKind(kind, shape, stages)
  if (slots.length === 0) return null

  const bindingFor = (slot: string) =>
    bindings.find((binding) => binding.slot === slot) ?? null

  const upsert = (slot: string, next: MetricBinding | null) => {
    const rest = bindings.filter((binding) => binding.slot !== slot)
    onChange(next ? [...rest, next] : rest)
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-semibold">What makes up this number</h3>
        <p className="text-sm text-muted-foreground">
          Bind each driver to a source and the goal can check that its parts
          add up to the headline. Required drivers must be bound before the
          goal can be marked on track.
        </p>
      </div>
      {slots.map(({ slot, required }) => {
        const binding = bindingFor(slot)
        return (
          <div key={slot} className="rounded-xl border p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {SLOT_LABELS[slot] ?? slot}
                {required && <span className="ml-1 text-destructive">*</span>}
              </span>
              {binding && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => upsert(slot, null)}
                >
                  Remove
                </button>
              )}
            </div>
            {binding ? (
              <MetricBindingFields
                binding={binding}
                sources={sources}
                onChange={(next) => upsert(slot, { ...next, slot, role: 'component' })}
              />
            ) : (
              <button
                type="button"
                className="text-sm text-chart-blue underline"
                onClick={() =>
                  upsert(slot, {
                    label: SLOT_LABELS[slot] ?? slot,
                    role: 'component',
                    slot,
                    source: 'manual',
                    metricKey: 'manual.value',
                    unit: 'usd',
                    connectionRef: null,
                    config: {},
                  })
                }
              >
                Bind a source
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
```

> Match `MetricBindingFields`' actual prop names by reading its signature at `src/components/goals/metric-binding-fields.tsx:59-67` before wiring — the `sources` and `onChange` names above are the expected shape, not a guess to be trusted blindly.

- [ ] **Step 5: Render it in the wizard**

In `src/app/goals/new/page.tsx`, hold component bindings in the same state array as the existing metric bindings and render `<CompositionFields />` after the primary metric section. Include the components in the create POST body's `metrics` array — they are ordinary metric entries carrying `role: 'component'` and a `slot` — and send `composition: { kind }` (plus `shape`/`stages`/`weights` for KPI) when at least one component is bound.

- [ ] **Step 6: Run tests**

Run: `npx tsc --noEmit && npx tsx --test src/components/goals/__tests__/composition-fields.test.tsx && npm test 2>&1 | tail -15`
Expected: PASS — 6 new tests plus the full suite.

- [ ] **Step 7: Commit**

```bash
git add src/components/goals/composition-fields.tsx src/components/goals/metric-binding-fields.tsx src/components/goals/__tests__/composition-fields.test.tsx src/app/goals/new/page.tsx
git commit -m "feat(goals): bind composition components in the goal wizard"
```

---

### Task 15: CompositionStrip on the goal detail page

**Files:**
- Create: `src/components/goals/composition-strip.tsx`
- Modify: `src/app/goals/[id]/page.tsx` (render below the status strip)
- Modify: `src/lib/types.ts` (`GoalDetail` gains `compositionState`)
- Modify: `src/app/api/goals/[id]/route.ts` (return `compositionState`)
- Test: `src/components/goals/__tests__/composition-strip.test.tsx`

**Interfaces:**
- Consumes: `CompositionState` (Task 9), `SLOT_LABELS` (Task 14)
- Produces: `compositionSummary(state: CompositionState | null): { tone: 'ok' | 'warn' | 'unknown'; headline: string; detail: string[] } | null`, `<CompositionStrip state />`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/goals/__tests__/composition-strip.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositionSummary } from '../composition-strip'

test('a null state renders nothing', () => {
  assert.equal(compositionSummary(null), null)
})

test('a complete reconciled composition reads as ok with its variance', () => {
  const summary = compositionSummary({
    level: 'complete',
    boundPct: 100,
    derived: 2_380_000,
    variancePct: -1.2,
    reconciliation: 'reconciled',
    breachedGates: [],
    missing: [],
    reasons: [],
  })
  assert.equal(summary?.tone, 'ok')
  assert.ok(summary.headline.includes('reconcile'))
  assert.ok(summary.detail.some((line) => line.includes('1.2')))
})

test('drift reads as a warning', () => {
  const summary = compositionSummary({
    level: 'complete',
    boundPct: 100,
    derived: 900_000,
    variancePct: 42.5,
    reconciliation: 'drifted',
    breachedGates: [],
    missing: [],
    reasons: ['Components do not reconcile to the reported number (42.5% variance).'],
  })
  assert.equal(summary?.tone, 'warn')
  assert.ok(summary.detail.some((line) => line.includes('42.5')))
})

test('missing drivers are named in plain language', () => {
  const summary = compositionSummary({
    level: 'partial',
    boundPct: 50,
    derived: null,
    variancePct: null,
    reconciliation: 'read_only',
    breachedGates: [],
    missing: ['churned_arr', 'contraction_arr'],
    reasons: ['Composition incomplete — not bound: churned_arr, contraction_arr.'],
  })
  assert.equal(summary?.tone, 'warn')
  assert.ok(summary.detail.join(' ').includes('Churned ARR'))
})

test('an unmeasured composition is unknown, not a warning', () => {
  // Nothing bound yet is not the same as something wrong.
  const summary = compositionSummary({
    level: 'unbound',
    boundPct: 0,
    derived: null,
    variancePct: null,
    reconciliation: 'unmeasured',
    breachedGates: [],
    missing: ['new_arr'],
    reasons: [],
  })
  assert.equal(summary?.tone, 'unknown')
})

test('a breached gate is surfaced with its slot label', () => {
  const summary = compositionSummary({
    level: 'complete',
    boundPct: 100,
    derived: 300_000,
    variancePct: 0,
    reconciliation: 'reconciled',
    breachedGates: ['pipeline_coverage'],
    missing: [],
    reasons: ['pipeline_coverage is 1.9 against a 3 floor.'],
  })
  assert.equal(summary?.tone, 'warn')
  assert.ok(summary.detail.join(' ').includes('Pipeline coverage'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/goals/__tests__/composition-strip.test.tsx`
Expected: FAIL — cannot find module `../composition-strip`

- [ ] **Step 3: Implement `composition-strip.tsx`**

```tsx
'use client'

/**
 * Makes gating legible. A goal capped at at_risk by its composition must say
 * why, or the risk badge reads as arbitrary.
 *
 * 'unbound' is toned 'unknown' rather than 'warn': nothing bound yet is a
 * setup state, not a failure, and colouring it red would punish a user
 * mid-configuration.
 */
import { AlertTriangle, CircleCheck, CircleHelp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { CompositionState } from '@/lib/goals/composition'
import { SLOT_LABELS } from './composition-fields'

const label = (slot: string) => SLOT_LABELS[slot] ?? slot

export function compositionSummary(
  state: CompositionState | null,
): { tone: 'ok' | 'warn' | 'unknown'; headline: string; detail: string[] } | null {
  if (!state) return null

  const detail: string[] = []
  if (state.missing.length > 0) {
    detail.push(`Not bound yet: ${state.missing.map(label).join(', ')}.`)
  }
  if (state.variancePct !== null) {
    const direction = state.variancePct < 0 ? 'below' : 'above'
    detail.push(
      `Drivers sum ${Math.abs(state.variancePct).toFixed(1)}% ${direction} the reported number.`,
    )
  }
  for (const gate of state.breachedGates) {
    const reason = state.reasons.find((entry) => entry.startsWith(gate))
    detail.push(reason ? `${label(gate)}: ${reason.slice(gate.length).trim()}` : `${label(gate)} is below its floor.`)
  }

  if (state.reconciliation === 'unmeasured' || state.level === 'unbound') {
    return {
      tone: 'unknown',
      headline: 'Composition not bound yet',
      detail,
    }
  }
  if (
    state.reconciliation === 'drifted' ||
    state.level === 'partial' ||
    state.breachedGates.length > 0
  ) {
    return {
      tone: 'warn',
      headline:
        state.reconciliation === 'drifted'
          ? 'Drivers do not reconcile to the headline'
          : 'Composition incomplete',
      detail,
    }
  }
  return {
    tone: 'ok',
    headline: 'Drivers reconcile to the headline',
    detail,
  }
}

const TONE = {
  ok: { icon: CircleCheck, className: 'border-success/30 bg-success/5 text-success' },
  warn: { icon: AlertTriangle, className: 'border-warning/30 bg-warning/5 text-warning' },
  unknown: { icon: CircleHelp, className: 'border-border bg-muted/30 text-muted-foreground' },
} as const

export function CompositionStrip({ state }: { state: CompositionState | null }) {
  const summary = compositionSummary(state)
  if (!summary) return null
  const { icon: Icon, className } = TONE[summary.tone]
  return (
    <Card className={cn('flex items-start gap-3 p-4', className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{summary.headline}</p>
        {summary.detail.map((line) => (
          <p key={line} className="text-sm text-muted-foreground">
            {line}
          </p>
        ))}
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: Surface `compositionState` through the API and page**

In `src/lib/types.ts`, add to `GoalDetail`:

```ts
  /** Per-evaluation composition summary; null for uncomposed goals. */
  compositionState: CompositionState | null
```

In `src/app/api/goals/[id]/route.ts`, add `compositionState: true` to the goal `select`/`include` and pass it through the response mapper as `(goal.compositionState ?? null) as CompositionState | null`.

In `src/app/goals/[id]/page.tsx`, render below the existing status strip:

```tsx
<CompositionStrip state={loaded.goal.compositionState} />
```

- [ ] **Step 5: Run tests**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -15`
Expected: PASS — 6 new tests plus the full suite.

- [ ] **Step 6: Commit**

```bash
git add src/components/goals/composition-strip.tsx src/components/goals/__tests__/composition-strip.test.tsx src/lib/types.ts "src/app/api/goals/[id]/route.ts" "src/app/goals/[id]/page.tsx"
git commit -m "feat(goals): surface composition state on the goal detail page"
```

---

### Task 16: Full verification

**Files:** none created; this task only runs and fixes.

- [ ] **Step 1: Typecheck and full suite**

Run: `npx tsc --noEmit && npm test 2>&1 | tail -30`
Expected: zero type errors, zero failures.

- [ ] **Step 2: Run the DB-backed suites against the throwaway Postgres**

Run:
```bash
npx prisma migrate deploy
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test 2>&1 | tail -30
```
Expected: the `*-e2e.test.ts` suites execute rather than skip, and all pass. Migrations are deployed **first** — a missing column reads as a logic failure otherwise.

- [ ] **Step 3: Build**

Run: `npm run build 2>&1 | tail -20`
Expected: a successful production build. This catches client/server boundary mistakes in the two new components that `tsc --noEmit` does not.

- [ ] **Step 4: Route smoke**

Use the project `verify` skill's route-smoke protocol to exercise `POST /api/goals` with an ARR body carrying four component metrics and a `composition`, then `GET /api/goals/[id]` and confirm `compositionState` is present and populated.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "test(goals): verify composition end to end"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Kind reduction | 1 (mapping), 2 (SQL), 3 (literals) |
| §2 Components as `GoalMetric` rows | 2 (columns), 12 (API), 14 (UI) |
| §3 Slot vocabularies | 4, 5, 6, 14 |
| §4 Three rollups | 4, 5, 6 |
| §4 Shared post-rollup layer | 7, 8 |
| §4 Gating rules + downgrade invariant | 8 |
| §4 `evaluateComposite` + integration | 9, 10 |
| §4 Eight `role: 'primary'` sites | 10 (only `refresh.ts` changes; others untouched by construction) |
| §5 Universal settlement receipt | 11 |
| §6 Component binding UI | 14 |
| §6 `CompositionStrip` | 15 |
| §7 Testing | every task; 16 aggregates |
| §8 `assertKindAllowed` seam | 12 |
| §8 Copilot kind list as parameter | 13 |

**Gaps closed during review:**

- The spec did not mention that `src/lib/metrics/sources/stripe.ts` and `google-analytics.ts` branch on goal kind. Task 3 covers both, and records the deliberate loss of the `lead_gen` GA4 narrowing.
- The spec did not enumerate the 15 test files carrying stale kind literals, nor the two false-positive matches that must be left alone. Task 3 Step 4 does.
- Quota's rollup needs each child's *current value*, which `Goal` does not store. Task 10 Step 3 flags this explicitly rather than leaving `currentValue` silently undefined — the child readings must be loaded with the same single-query pattern as the components.

**Type consistency:** `GoalKind` (Task 1) is the single kind union consumed by Tasks 3, 9, 12, 13, 14. `GateFinding` is defined once in `rollup-quota.ts` (Task 5) and imported by `gates.ts` (Task 8) and `evaluate-composite.ts` (Task 9). `CompositionState` is defined in `evaluate-composite.ts` (Task 9) and consumed by Tasks 10, 11, 15. `CompletenessLevel` and `ReconcileStatus` originate in Task 7 and are imported, never restated. `SLOT_LABELS` is defined once in `composition-fields.tsx` (Task 14) and imported by `composition-strip.tsx` (Task 15) and `metric-binding-fields.tsx` (Task 14 Step 1).
