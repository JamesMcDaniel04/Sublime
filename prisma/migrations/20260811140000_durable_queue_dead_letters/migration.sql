CREATE TABLE "queue_dead_letters" (
  "id" TEXT NOT NULL,
  "organizationId" UUID,
  "queue" TEXT NOT NULL,
  "sourceJobId" TEXT,
  "executionType" TEXT NOT NULL,
  "executionId" TEXT,
  "outboxId" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "replayAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastReplayError" TEXT,
  "replayedByUserId" TEXT,
  "replayedAt" TIMESTAMPTZ(6),
  "resolvedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "queue_dead_letters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "queue_dead_letters_organizationId_status_createdAt_idx" ON "queue_dead_letters"("organizationId", "status", "createdAt");
CREATE INDEX "queue_dead_letters_queue_status_createdAt_idx" ON "queue_dead_letters"("queue", "status", "createdAt");
ALTER TABLE "queue_dead_letters" ADD CONSTRAINT "queue_dead_letters_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
