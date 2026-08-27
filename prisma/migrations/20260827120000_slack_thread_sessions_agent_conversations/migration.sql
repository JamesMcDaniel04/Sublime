-- A Slack thread may now be owned by an agent conversation, not only a flow.
-- Widening only (NOT NULL dropped, nullable columns added): safe in one deploy.
ALTER TABLE "slack_thread_sessions" ALTER COLUMN "flowId" DROP NOT NULL;
ALTER TABLE "slack_thread_sessions" ALTER COLUMN "flowRunId" DROP NOT NULL;
ALTER TABLE "slack_thread_sessions" ADD COLUMN "agentTaskId" TEXT;
ALTER TABLE "slack_thread_sessions" ADD COLUMN "agentRequestId" TEXT;
CREATE INDEX "slack_thread_sessions_agentRequestId_idx" ON "slack_thread_sessions"("agentRequestId");
