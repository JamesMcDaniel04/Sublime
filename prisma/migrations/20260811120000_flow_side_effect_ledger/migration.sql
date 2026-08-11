CREATE TABLE "flow_side_effects" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "flowRunId" TEXT NOT NULL,
  "flowRunStepId" TEXT NOT NULL,
  "effectKey" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "iterationPath" TEXT,
  "kind" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "safety" TEXT NOT NULL,
  "providerKey" TEXT,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'claimed',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "response" JSONB,
  "providerRequestId" TEXT,
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "flow_side_effects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_side_effects_effectKey_key" ON "flow_side_effects"("effectKey");
CREATE INDEX "flow_side_effects_organizationId_status_updatedAt_idx" ON "flow_side_effects"("organizationId", "status", "updatedAt");
CREATE INDEX "flow_side_effects_flowRunId_nodeId_idx" ON "flow_side_effects"("flowRunId", "nodeId");

ALTER TABLE "flow_side_effects" ADD CONSTRAINT "flow_side_effects_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_side_effects" ADD CONSTRAINT "flow_side_effects_flowRunId_fkey"
  FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_side_effects" ADD CONSTRAINT "flow_side_effects_flowRunStepId_fkey"
  FOREIGN KEY ("flowRunStepId") REFERENCES "flow_run_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
