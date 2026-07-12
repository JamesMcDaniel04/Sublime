-- CreateTable
CREATE TABLE "slack_workspace_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamName" TEXT,
    "botUserId" TEXT NOT NULL,
    "botToken" JSONB NOT NULL,
    "signingSecret" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_workspace_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_thread_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "bindingId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "threadTs" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "flowRunId" TEXT NOT NULL,
    "agentExecutionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_thread_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_workspace_connections_organizationId_teamId_key" ON "slack_workspace_connections"("organizationId", "teamId");

-- CreateIndex
CREATE INDEX "slack_thread_sessions_flowRunId_idx" ON "slack_thread_sessions"("flowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_thread_sessions_bindingId_channel_threadTs_key" ON "slack_thread_sessions"("bindingId", "channel", "threadTs");

-- AddForeignKey
ALTER TABLE "slack_workspace_connections" ADD CONSTRAINT "slack_workspace_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_thread_sessions" ADD CONSTRAINT "slack_thread_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
