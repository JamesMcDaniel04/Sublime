ALTER TABLE "goals" ADD COLUMN "recurrence" TEXT;
ALTER TABLE "goal_contributions" ADD COLUMN "seedKey" TEXT;

CREATE TABLE "goal_periods" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "goalId" TEXT NOT NULL,
  "periodStart" TIMESTAMPTZ(6) NOT NULL,
  "periodEnd" TIMESTAMPTZ(6) NOT NULL,
  "startValue" DOUBLE PRECISION NOT NULL,
  "targetValue" DOUBLE PRECISION NOT NULL,
  "finalValue" DOUBLE PRECISION NOT NULL,
  "outcome" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goal_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "goal_periods_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "goal_periods_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "goal_periods_organizationId_goalId_periodEnd_idx"
  ON "goal_periods"("organizationId", "goalId", "periodEnd");

CREATE TABLE "template_estimate_calibrations" (
  "seedKey" TEXT NOT NULL,
  "medianMinutes" INTEGER NOT NULL,
  "orgCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "template_estimate_calibrations_pkey" PRIMARY KEY ("seedKey")
);

CREATE TABLE "goal_benchmarks" (
  "kind" TEXT NOT NULL,
  "orgCount" INTEGER NOT NULL,
  "settledCount" INTEGER NOT NULL,
  "achievedCount" INTEGER NOT NULL,
  "topSeedKeys" JSONB NOT NULL DEFAULT '[]',
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "goal_benchmarks_pkey" PRIMARY KEY ("kind")
);
