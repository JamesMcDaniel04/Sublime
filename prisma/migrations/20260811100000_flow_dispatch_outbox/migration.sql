-- Durable flow queue handoff and explicit queue lifecycle.
ALTER TABLE "flow_runs"
  ADD COLUMN "queuedAt" TIMESTAMPTZ(6),
  ADD COLUMN "claimedAt" TIMESTAMPTZ(6),
  ADD COLUMN "heartbeatAt" TIMESTAMPTZ(6),
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "queueAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "waitGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "flow_runs_status_queuedAt_idx" ON "flow_runs"("status", "queuedAt");
CREATE INDEX "flow_runs_status_leaseExpiresAt_idx" ON "flow_runs"("status", "leaseExpiresAt");

CREATE TABLE "flow_dispatch_outbox" (
  "id" TEXT NOT NULL,
  "flowRunId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "dispatchKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(6),
  "publishedAt" TIMESTAMPTZ(6),
  "consumedAt" TIMESTAMPTZ(6),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "flow_dispatch_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_dispatch_outbox_dispatchKey_key" ON "flow_dispatch_outbox"("dispatchKey");
CREATE INDEX "flow_dispatch_outbox_status_availableAt_idx" ON "flow_dispatch_outbox"("status", "availableAt");
CREATE INDEX "flow_dispatch_outbox_organizationId_createdAt_idx" ON "flow_dispatch_outbox"("organizationId", "createdAt");

ALTER TABLE "flow_dispatch_outbox"
  ADD CONSTRAINT "flow_dispatch_outbox_flowRunId_fkey"
  FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_dispatch_outbox"
  ADD CONSTRAINT "flow_dispatch_outbox_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
