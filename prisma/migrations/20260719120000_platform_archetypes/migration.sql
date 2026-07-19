-- CreateTable
CREATE TABLE "platform_archetypes" (
  "id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "providers" JSONB NOT NULL,
  "triggerType" TEXT NOT NULL,
  "orgCount" INTEGER NOT NULL,
  "flowCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_archetypes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_archetypes_signature_key" ON "platform_archetypes"("signature");

-- CreateIndex
CREATE INDEX "platform_archetypes_orgCount_idx" ON "platform_archetypes"("orgCount");
