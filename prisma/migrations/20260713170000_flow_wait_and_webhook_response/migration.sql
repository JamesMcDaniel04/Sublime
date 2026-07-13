ALTER TABLE "flow_runs" ADD COLUMN "wakeAt" TIMESTAMP(3), ADD COLUMN "webhookResponse" JSONB;
CREATE INDEX "flow_runs_status_wakeAt_idx" ON "flow_runs"("status", "wakeAt");
