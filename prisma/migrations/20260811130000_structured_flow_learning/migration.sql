CREATE TABLE "flow_learning_observations" (
  "id" TEXT NOT NULL,
  "observationKey" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "flowId" TEXT NOT NULL,
  "flowRunId" TEXT NOT NULL,
  "nodeId" TEXT,
  "kind" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "features" JSONB NOT NULL DEFAULT '{}',
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_learning_observations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_learning_feedback" (
  "id" TEXT NOT NULL,
  "observationId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "source" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "score" INTEGER,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_learning_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_learning_observations_observationKey_key" ON "flow_learning_observations"("observationKey");
CREATE INDEX "flow_learning_observations_organizationId_flowId_occurredAt_idx" ON "flow_learning_observations"("organizationId", "flowId", "occurredAt");
CREATE INDEX "flow_learning_observations_organizationId_subject_outcome_idx" ON "flow_learning_observations"("organizationId", "subject", "outcome");
CREATE INDEX "flow_learning_feedback_organizationId_observationId_createdAt_idx" ON "flow_learning_feedback"("organizationId", "observationId", "createdAt");
CREATE INDEX "flow_learning_feedback_organizationId_outcome_createdAt_idx" ON "flow_learning_feedback"("organizationId", "outcome", "createdAt");

ALTER TABLE "flow_learning_observations" ADD CONSTRAINT "flow_learning_observations_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_learning_observations" ADD CONSTRAINT "flow_learning_observations_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_learning_observations" ADD CONSTRAINT "flow_learning_observations_flowRunId_fkey"
  FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_learning_feedback" ADD CONSTRAINT "flow_learning_feedback_observationId_fkey"
  FOREIGN KEY ("observationId") REFERENCES "flow_learning_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_learning_feedback" ADD CONSTRAINT "flow_learning_feedback_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
