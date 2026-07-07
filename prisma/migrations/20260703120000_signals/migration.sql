-- AlterTable
ALTER TABLE "public"."agent_executions" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "signalId" TEXT;

-- CreateTable
CREATE TABLE "public"."signals" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "accountId" TEXT,
    "opportunityId" TEXT,
    "stakeholderId" TEXT,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "provenanceUrl" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."signal_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "signalType" TEXT NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "agentTaskId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signal_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signals_dedupeKey_key" ON "public"."signals"("dedupeKey");

-- CreateIndex
CREATE INDEX "signals_organizationId_receivedAt_idx" ON "public"."signals"("organizationId", "receivedAt");

-- CreateIndex
CREATE INDEX "signals_organizationId_type_idx" ON "public"."signals"("organizationId", "type");

-- CreateIndex
CREATE INDEX "signal_subscriptions_organizationId_signalType_isActive_idx" ON "public"."signal_subscriptions"("organizationId", "signalType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "agent_executions_organizationId_idempotencyKey_key" ON "public"."agent_executions"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "public"."signals" ADD CONSTRAINT "signals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."signal_subscriptions" ADD CONSTRAINT "signal_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."signal_subscriptions" ADD CONSTRAINT "signal_subscriptions_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "public"."agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_executions" ADD CONSTRAINT "agent_executions_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "public"."signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

