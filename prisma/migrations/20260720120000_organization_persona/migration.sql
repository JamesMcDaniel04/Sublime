-- Durable per-organization persona (org-persona-pipeline spec). Department
-- weights are deterministic and always present; narrative/confidence stay
-- NULL until real usage signal exists (a scan profile or activity events).
CREATE TABLE "organization_personas" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "departmentWeights" JSONB NOT NULL DEFAULT '{}',
    "narrative" TEXT,
    "confidence" DOUBLE PRECISION,
    "signalsSummary" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "organization_personas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_personas_organizationId_key" ON "organization_personas"("organizationId");

ALTER TABLE "organization_personas" ADD CONSTRAINT "organization_personas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
