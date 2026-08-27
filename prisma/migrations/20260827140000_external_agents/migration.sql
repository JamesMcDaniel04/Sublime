-- External agents (BYOA outbound). Additive: a defaulted column and a new table.
--
-- Adding a foreign key takes a lock on agent_tasks; bound the wait so a busy
-- deploy fails fast and retries instead of part-applying (the api_keys
-- migration's incident, and the rule migration-lock-safety.test enforces).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "agent_tasks" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'native';
CREATE TABLE "external_agent_bindings" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "timeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "external_agent_bindings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_agent_bindings_agentTaskId_key" ON "external_agent_bindings"("agentTaskId");
CREATE INDEX "external_agent_bindings_organizationId_idx" ON "external_agent_bindings"("organizationId");
ALTER TABLE "external_agent_bindings" ADD CONSTRAINT "external_agent_bindings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_agent_bindings" ADD CONSTRAINT "external_agent_bindings_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
