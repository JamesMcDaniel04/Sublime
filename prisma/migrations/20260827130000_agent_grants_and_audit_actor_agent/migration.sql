-- Per-agent permission grants, and the agent dimension on audit rows.
-- Additive only (nullable columns + an index): safe in one deploy. A NULL
-- grant is a legacy, unrestricted agent — no existing row changes behaviour.
ALTER TABLE "agent_tasks" ADD COLUMN "grants" JSONB;
ALTER TABLE "audit_events" ADD COLUMN "actorAgentId" TEXT;
CREATE INDEX "audit_events_organizationId_actorAgentId_idx" ON "audit_events"("organizationId", "actorAgentId");
