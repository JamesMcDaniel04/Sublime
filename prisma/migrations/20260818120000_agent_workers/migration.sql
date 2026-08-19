-- Roster identities. A worker is the person-shaped tile on /agents: one avatar,
-- one role, with the agents that do the work grouped underneath it. Templates
-- are added TO a worker instead of each becoming a standalone agent, so one
-- avatar can hold a group of agents doing different jobs.
CREATE TABLE "agent_workers" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "avatarSeed" TEXT,
    "roleLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_workers_organizationId_updatedAt_idx" ON "agent_workers"("organizationId", "updatedAt");

ALTER TABLE "agent_workers" ADD CONSTRAINT "agent_workers_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_workers" ADD CONSTRAINT "agent_workers_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable on purpose: an agent with no worker stands alone and renders as its
-- own tile, so every agent that already exists keeps working with no backfill.
ALTER TABLE "agent_tasks" ADD COLUMN "workerId" TEXT;

CREATE INDEX "agent_tasks_workerId_idx" ON "agent_tasks"("workerId");

-- SET NULL, never CASCADE: deleting a worker must not destroy the agents that
-- worked under it, nor their run history. They fall back to standalone tiles.
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "agent_workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
