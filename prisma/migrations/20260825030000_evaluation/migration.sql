-- Evaluation as a product feature, not a CLI harness.
--
-- The load-bearing column is eval_runs.agentVersion: without recording WHICH
-- version of an agent a run evaluated, "did this change make it better" is
-- unanswerable, and a stored score is just a number with no referent.
CREATE TABLE "eval_datasets" (
  "id" TEXT NOT NULL, "organizationId" UUID NOT NULL, "agentTaskId" TEXT,
  "name" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "eval_datasets_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "eval_cases" (
  "id" TEXT NOT NULL, "datasetId" TEXT NOT NULL, "organizationId" UUID NOT NULL,
  "input" TEXT NOT NULL, "rubric" TEXT NOT NULL, "mustContain" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "eval_runs" (
  "id" TEXT NOT NULL, "datasetId" TEXT NOT NULL, "organizationId" UUID NOT NULL,
  "agentTaskId" TEXT NOT NULL, "agentVersion" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'running',
  "passed" INTEGER NOT NULL DEFAULT 0, "failed" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "eval_case_results" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL, "passed" BOOLEAN NOT NULL, "score" DOUBLE PRECISION,
  "output" TEXT NOT NULL, "notes" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "eval_case_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eval_datasets_organizationId_agentTaskId_idx" ON "eval_datasets" ("organizationId", "agentTaskId");
CREATE INDEX "eval_cases_organizationId_datasetId_idx" ON "eval_cases" ("organizationId", "datasetId");
CREATE INDEX "eval_runs_organizationId_datasetId_startedAt_idx" ON "eval_runs" ("organizationId", "datasetId", "startedAt");
CREATE INDEX "eval_case_results_organizationId_runId_idx" ON "eval_case_results" ("organizationId", "runId");

ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "eval_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "eval_case_results" ADD CONSTRAINT "eval_case_results_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
