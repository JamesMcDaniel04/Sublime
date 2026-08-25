-- CreateTable
CREATE TABLE "process_baselines" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "volume" INTEGER NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "periodDays" DOUBLE PRECISION,
    "distinctActors" INTEGER NOT NULL,
    "medianCycleTimeHours" DOUBLE PRECISION,
    "reworkRate" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL,
    "handlingTimeTableVersion" INTEGER NOT NULL,
    "handlingMinutes" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "process_baselines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "process_baselines_organizationId_confidence_idx" ON "process_baselines"("organizationId", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "process_baselines_organizationId_source_action_entityType_key" ON "process_baselines"("organizationId", "source", "action", "entityType");

-- AddForeignKey
ALTER TABLE "process_baselines" ADD CONSTRAINT "process_baselines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
