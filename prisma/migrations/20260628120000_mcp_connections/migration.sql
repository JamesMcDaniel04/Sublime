-- CreateTable
CREATE TABLE "mcp_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serverUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_connections_organizationId_isActive_idx" ON "mcp_connections"("organizationId", "isActive");

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
