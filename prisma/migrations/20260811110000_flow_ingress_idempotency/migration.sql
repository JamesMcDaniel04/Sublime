ALTER TABLE "flow_runs"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyPayloadHash" TEXT;

CREATE UNIQUE INDEX "flow_runs_organizationId_flowId_idempotencyKey_key"
  ON "flow_runs"("organizationId", "flowId", "idempotencyKey");
