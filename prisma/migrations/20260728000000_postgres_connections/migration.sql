-- Native Postgres integration: customer-owned databases connected without Nango.
CREATE TABLE "postgres_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "displayTarget" TEXT NOT NULL DEFAULT '',
    "allowWrites" BOOLEAN NOT NULL DEFAULT false,
    "defaultSchema" TEXT NOT NULL DEFAULT 'public',
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastError" TEXT,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "postgres_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "postgres_connections_organizationId_name_key" ON "postgres_connections"("organizationId", "name");
CREATE INDEX "postgres_connections_organizationId_status_idx" ON "postgres_connections"("organizationId", "status");

ALTER TABLE "postgres_connections" ADD CONSTRAINT "postgres_connections_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
