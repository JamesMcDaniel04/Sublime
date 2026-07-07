-- CreateTable
CREATE TABLE "agent_chat_sessions" (
    "id" TEXT NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_chat_sessions_agentTaskId_userId_updatedAt_idx" ON "agent_chat_sessions"("agentTaskId", "userId", "updatedAt");

-- AlterTable
ALTER TABLE "agent_chat_messages" ADD COLUMN "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "agent_chat_messages_sessionId_createdAt_idx" ON "agent_chat_messages"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_chat_sessions" ADD CONSTRAINT "agent_chat_sessions_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
