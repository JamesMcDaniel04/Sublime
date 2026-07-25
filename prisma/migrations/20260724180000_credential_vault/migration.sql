-- Reusable, org-scoped credential vault for outbound request auth. authConfig
-- holds AES-256-GCM payloads for secret fields plus plaintext metadata.
CREATE TABLE "credentials" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credentials_organizationId_userId_name_key" ON "credentials"("organizationId", "userId", "name");
CREATE INDEX "credentials_organizationId_isActive_idx" ON "credentials"("organizationId", "isActive");
CREATE INDEX "credentials_organizationId_userId_isActive_idx" ON "credentials"("organizationId", "userId", "isActive");

ALTER TABLE "credentials" ADD CONSTRAINT "credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
