-- CreateTable
CREATE TABLE "agent_requests" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestedByUserId" TEXT,
    "agentTaskId" TEXT NOT NULL,
    "goalId" TEXT,
    "text" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'app',
    "originMeta" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executionId" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(6),

    CONSTRAINT "agent_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_requests_organizationId_requestedByUserId_status_crea_idx" ON "agent_requests"("organizationId", "requestedByUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "agent_requests_organizationId_agentTaskId_createdAt_idx" ON "agent_requests"("organizationId", "agentTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_requests_organizationId_goalId_idx" ON "agent_requests"("organizationId", "goalId");

-- CreateIndex
CREATE INDEX "agent_requests_executionId_idx" ON "agent_requests"("executionId");

-- AddForeignKey
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

