-- CreateTable
CREATE TABLE "agent_chat_messages" (
    "id" TEXT NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_chat_messages_agentTaskId_userId_createdAt_idx" ON "agent_chat_messages"("agentTaskId", "userId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_chat_messages" ADD CONSTRAINT "agent_chat_messages_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
