-- CreateTable
CREATE TABLE "nango_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "connectionId" TEXT NOT NULL,
    "providerConfigKey" TEXT NOT NULL,
    "provider" TEXT,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nango_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_secrets" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'api_key',
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nango_connections_organizationId_connectionId_key" ON "nango_connections"("organizationId", "connectionId");

-- CreateIndex
CREATE INDEX "nango_connections_organizationId_providerConfigKey_idx" ON "nango_connections"("organizationId", "providerConfigKey");

-- CreateIndex
CREATE UNIQUE INDEX "integration_secrets_organizationId_provider_key" ON "integration_secrets"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "integration_secrets_organizationId_isActive_idx" ON "integration_secrets"("organizationId", "isActive");

-- AddForeignKey
ALTER TABLE "nango_connections" ADD CONSTRAINT "nango_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_secrets" ADD CONSTRAINT "integration_secrets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
