-- Goals v2.4: multi-metric goals + persisted dashboard layouts.

ALTER TABLE "goal_metrics" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE "goal_metrics" ADD COLUMN "label" TEXT;
ALTER TABLE "goal_metrics" ADD COLUMN "unit" TEXT;

DROP INDEX "goal_metrics_goalId_key";
CREATE INDEX "goal_metrics_goalId_idx" ON "goal_metrics"("goalId");
CREATE UNIQUE INDEX "goal_metrics_one_primary_per_goal"
  ON "goal_metrics"("goalId") WHERE "role" = 'primary';

ALTER TABLE "goals" ADD COLUMN "dashboardLayout" JSONB;
