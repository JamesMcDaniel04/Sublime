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
--    component rows -- one metric per slot per goal.
ALTER TABLE "goal_metrics" ADD COLUMN "slot" TEXT;
CREATE UNIQUE INDEX "goal_metrics_goalId_slot_key" ON "goal_metrics"("goalId", "slot");

-- 5. Settlement receipt. GoalPeriod becomes the universal settlement record
--    (recurring AND non-recurring), carrying what actually decided the outcome.
ALTER TABLE "goal_periods" ADD COLUMN "compositionSnapshot" JSONB;
ALTER TABLE "goal_periods" ADD COLUMN "reconciliationVariancePct" DOUBLE PRECISION;
