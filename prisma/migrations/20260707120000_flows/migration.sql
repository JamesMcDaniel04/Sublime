-- CreateTable
CREATE TABLE "flows" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "graph" JSONB NOT NULL DEFAULT '{}',
  "visibility" TEXT NOT NULL DEFAULT 'shared',
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_runs" (
  "id" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "trigger" JSONB NOT NULL DEFAULT '{}',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "organizationId" UUID NOT NULL,
  "userId" TEXT,
  CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_run_steps" (
  "id" TEXT NOT NULL,
  "flowRunId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "agentExecutionId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "flow_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flows_organizationId_updatedAt_idx" ON "flows"("organizationId", "updatedAt");
CREATE INDEX "flow_runs_flowId_startedAt_idx" ON "flow_runs"("flowId", "startedAt");
CREATE INDEX "flow_run_steps_flowRunId_order_idx" ON "flow_run_steps"("flowRunId", "order");

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_run_steps" ADD CONSTRAINT "flow_run_steps_flowRunId_fkey"
  FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
