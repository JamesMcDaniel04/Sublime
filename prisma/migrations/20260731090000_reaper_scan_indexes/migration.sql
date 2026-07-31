-- Reaper sweeps (stuck/cancelling/pending) filter on status + startedAt
-- globally; cross-org scheduling scans filter on status alone. Every existing
-- index on both tables leads with organizationId, so these sweeps were
-- sequential scans that grow with total platform history.
CREATE INDEX "agent_executions_status_startedAt_idx" ON "agent_executions"("status", "startedAt");

CREATE INDEX "agent_tasks_status_idx" ON "agent_tasks"("status");
