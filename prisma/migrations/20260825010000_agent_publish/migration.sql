-- Draft/published lifecycle for agents, mirroring Flow.publishedGraph.
--
-- NULL publishedConfig means "never published": runs read the live columns,
-- which is exactly the behaviour every existing agent has today. That is why
-- this ships without a backfill — an agent opts into the draft split the
-- first time it is published, and nothing changes for one that never is.
ALTER TABLE "agent_tasks" ADD COLUMN "publishedConfig" JSONB;
ALTER TABLE "agent_tasks" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "agent_tasks" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
