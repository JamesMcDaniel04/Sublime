-- Per-flow state that survives between runs (n8n's $getWorkflowStaticData).
--
-- One row per (flow, key) rather than a JSON blob on flows: two keys written
-- by different steps in the same run would race on a single column, and
-- last-write-wins there silently drops a cursor. The unique index is what
-- makes the upsert safe under that concurrency.
CREATE TABLE "flow_static_data" (
  "id"             TEXT NOT NULL,
  "flowId"         TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "key"            TEXT NOT NULL,
  "value"          JSONB NOT NULL DEFAULT '{}',
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_static_data_pkey" PRIMARY KEY ("id")
);

-- Org first: every write must be org-scoped by construction, not by memory.
CREATE UNIQUE INDEX "flow_static_data_organizationId_flowId_key_key" ON "flow_static_data" ("organizationId", "flowId", "key");
CREATE INDEX "flow_static_data_organizationId_flowId_idx" ON "flow_static_data" ("organizationId", "flowId");

ALTER TABLE "flow_static_data" ADD CONSTRAINT "flow_static_data_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_static_data" ADD CONSTRAINT "flow_static_data_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
