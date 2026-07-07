-- CreateTable
CREATE TABLE "public"."agent_connectors" (
    "id" TEXT NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'external',
    "mcpConnectionId" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_connectors_organizationId_idx" ON "public"."agent_connectors"("organizationId");

-- CreateIndex
CREATE INDEX "agent_connectors_mcpConnectionId_idx" ON "public"."agent_connectors"("mcpConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_connectors_agentTaskId_connectorKey_key" ON "public"."agent_connectors"("agentTaskId", "connectorKey");

-- AddForeignKey
ALTER TABLE "public"."agent_connectors" ADD CONSTRAINT "agent_connectors_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "public"."agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_connectors" ADD CONSTRAINT "agent_connectors_mcpConnectionId_fkey" FOREIGN KEY ("mcpConnectionId") REFERENCES "public"."mcp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

