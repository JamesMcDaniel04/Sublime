-- AlterTable
ALTER TABLE "user_suggestions" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerUserId" TEXT,
    "parentGoalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'increase',
    "unit" TEXT NOT NULL DEFAULT 'usd',
    "startValue" DOUBLE PRECISION NOT NULL,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetDate" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "riskLevel" TEXT NOT NULL DEFAULT 'no_data',
    "lastEvaluatedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_metrics" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "connectionRef" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "refreshIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "lastSyncAt" TIMESTAMPTZ(6),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "goal_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_datapoints" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalMetricId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMPTZ(6) NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'sync',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_datapoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_contributions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "estimatedMinutesSavedPerRun" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goals_organizationId_status_idx" ON "goals"("organizationId", "status");

-- CreateIndex
CREATE INDEX "goals_organizationId_ownerUserId_status_idx" ON "goals"("organizationId", "ownerUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "goal_metrics_goalId_key" ON "goal_metrics"("goalId");

-- CreateIndex
CREATE INDEX "goal_metrics_organizationId_source_idx" ON "goal_metrics"("organizationId", "source");

-- CreateIndex
CREATE INDEX "metric_datapoints_organizationId_goalMetricId_capturedAt_idx" ON "metric_datapoints"("organizationId", "goalMetricId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "metric_datapoints_goalMetricId_bucketKey_key" ON "metric_datapoints"("goalMetricId", "bucketKey");

-- CreateIndex
CREATE INDEX "goal_contributions_organizationId_goalId_idx" ON "goal_contributions"("organizationId", "goalId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_contributions_goalId_resourceType_resourceId_key" ON "goal_contributions"("goalId", "resourceType", "resourceId");

-- AddForeignKey
-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_metrics" ADD CONSTRAINT "goal_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_metrics" ADD CONSTRAINT "goal_metrics_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_datapoints" ADD CONSTRAINT "metric_datapoints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_datapoints" ADD CONSTRAINT "metric_datapoints_goalMetricId_fkey" FOREIGN KEY ("goalMetricId") REFERENCES "goal_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_contributions" ADD CONSTRAINT "goal_contributions_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "agent_executions_organizationId_userId_agentTaskId_startedAt_id" RENAME TO "agent_executions_organizationId_userId_agentTaskId_startedA_idx";

