-- Goal-agent maturation (spec 2026-08-01): multi-goal arbitration, persisted
-- in-run plans, and run→goal contribution verdicts.

-- User-set arbitration priority; null = rank automatically (risk, deadline).
ALTER TABLE "goals" ADD COLUMN "priority" INTEGER;

-- Persisted in-run plan artifact { steps, revisions }; null when the run
-- never planned. Pruned with the run like the transcript.
ALTER TABLE "agent_executions" ADD COLUMN "plan" JSONB;

-- Reflection's per-run judgment of whether a run advanced a linked goal.
-- runId is deliberately not an FK: verdicts outlive run pruning (same
-- reasoning as goal_work.runId).
CREATE TABLE "goal_run_verdicts" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_run_verdicts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_run_verdicts_organizationId_goalId_createdAt_idx"
    ON "goal_run_verdicts"("organizationId", "goalId", "createdAt");

CREATE INDEX "goal_run_verdicts_organizationId_goalId_resourceId_createdAt_idx"
    ON "goal_run_verdicts"("organizationId", "goalId", "resourceId", "createdAt");

ALTER TABLE "goal_run_verdicts" ADD CONSTRAINT "goal_run_verdicts_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goal_run_verdicts" ADD CONSTRAINT "goal_run_verdicts_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
