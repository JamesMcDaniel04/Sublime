ALTER TABLE organizations ADD COLUMN settings JSONB NOT NULL DEFAULT '{}';
ALTER TABLE flows ADD COLUMN metadata JSONB;

-- At most one hidden org-intelligence holder AgentTask per org: prevents a
-- get-or-create race (concurrent first-scans) from creating two rows and
-- fragmenting org-wide memory across them.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_tasks_org_intelligence_unique" ON "agent_tasks" ("organizationId") WHERE "agentType" = 'SYSTEM';
