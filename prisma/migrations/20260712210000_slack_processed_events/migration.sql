-- Atomic Slack ingress dedup ledger: the @@unique([bindingId, dedupId])
-- constraint IS the dedup mechanism (a racing duplicate insert hits it and
-- loses, decided by the database instead of a check-then-set cache read).
CREATE TABLE "slack_processed_events" (
    "id" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "dedupId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_processed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_processed_events_createdAt_idx" ON "slack_processed_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "slack_processed_events_bindingId_dedupId_key" ON "slack_processed_events"("bindingId", "dedupId");
