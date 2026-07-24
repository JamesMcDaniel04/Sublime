-- Per-user pinned node outputs: dev-time fixtures for single-node testing.
-- Deliberately outside Flow.graph so pins never reach publishedGraph or export.
CREATE TABLE "flow_node_pins" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "output" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_node_pins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_node_pins_flowId_nodeId_userId_key" ON "flow_node_pins"("flowId", "nodeId", "userId");

CREATE INDEX "flow_node_pins_flowId_userId_idx" ON "flow_node_pins"("flowId", "userId");

ALTER TABLE "flow_node_pins" ADD CONSTRAINT "flow_node_pins_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
