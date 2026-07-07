-- DropForeignKey
ALTER TABLE "public"."custom_dashboards" DROP CONSTRAINT "custom_dashboards_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "public"."custom_dashboards" DROP CONSTRAINT "custom_dashboards_userId_fkey";

-- AlterTable
ALTER TABLE "public"."agent_executions" ADD COLUMN     "inputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "transcript" JSONB,
ALTER COLUMN "executionTime" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."agent_tasks" ADD COLUMN     "folder" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'shared';

-- AlterTable
ALTER TABLE "public"."integrations" DROP COLUMN "accessToken",
DROP COLUMN "lastOauthRefresh",
DROP COLUMN "refreshToken",
DROP COLUMN "type";

-- AlterTable
ALTER TABLE "public"."mcp_agents" ALTER COLUMN "agentType" TYPE TEXT USING "agentType"::text;

-- DropTable
DROP TABLE "public"."custom_dashboards";

-- DropEnum
DROP TYPE "public"."IntegrationType";

-- DropEnum
DROP TYPE "public"."MCPAgentType";

-- CreateTable
CREATE TABLE "public"."execution_messages" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."notifications" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "agentTaskId" TEXT,
    "executionId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "execution_messages_executionId_createdAt_idx" ON "public"."execution_messages"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organizationId_createdAt_idx" ON "public"."notifications"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organizationId_userId_readAt_idx" ON "public"."notifications"("organizationId", "userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "public"."push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "public"."push_subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_agents_userId_organizationId_agentType_key" ON "public"."mcp_agents"("userId", "organizationId", "agentType");

-- AddForeignKey
ALTER TABLE "public"."execution_messages" ADD CONSTRAINT "execution_messages_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "public"."agent_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

