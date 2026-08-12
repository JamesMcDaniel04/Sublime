-- Workspace-wide flow run history (GET /api/flows/runs).
--
-- Every existing index on flow_runs leads with flowId or status, so "the newest
-- runs in this organization, across all flows" had no usable index and degraded
-- into a scan as a tenant's history grew.
--
-- Plain (non-CONCURRENT) CREATE INDEX, matching every other migration here:
-- Prisma applies each migration inside a transaction, which CONCURRENTLY is not
-- allowed to run in.
CREATE INDEX IF NOT EXISTS "flow_runs_organizationId_startedAt_idx" ON "flow_runs"("organizationId", "startedAt");
