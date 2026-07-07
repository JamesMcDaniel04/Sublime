-- CreateTable
CREATE TABLE "custom_signals" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'account',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_signals_organizationId_userId_updatedAt_idx" ON "custom_signals"("organizationId", "userId", "updatedAt");
