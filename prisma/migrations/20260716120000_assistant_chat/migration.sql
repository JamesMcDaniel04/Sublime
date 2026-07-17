-- CreateTable
CREATE TABLE "assistant_chat_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_chat_messages" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_chat_sessions_organizationId_userId_updatedAt_idx" ON "assistant_chat_sessions"("organizationId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "assistant_chat_messages_sessionId_createdAt_idx" ON "assistant_chat_messages"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "assistant_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

