-- Activity ledger models: ActivityEvent, ActivityBackfill, ActivityTriggerClaim
CREATE TABLE "activity_events" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "actorRef" TEXT NOT NULL,
  "actorName" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityRef" TEXT NOT NULL,
  "entityName" TEXT,
  "previousState" JSONB,
  "newState" JSONB,
  "participants" JSONB NOT NULL DEFAULT '[]',
  "businessContext" JSONB NOT NULL DEFAULT '{}',
  "outcome" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ingestKind" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "indexedAt" TIMESTAMP(3),
  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity_backfills" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "connectionRef" TEXT NOT NULL,
  "window" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "cursor" TEXT,
  "eventsIngested" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "activity_backfills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity_trigger_claims" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_trigger_claims_pkey" PRIMARY KEY ("id")
);

-- Indexes for ActivityEvent
CREATE UNIQUE INDEX "activity_events_organizationId_dedupeKey_key" ON "activity_events"("organizationId", "dedupeKey");
CREATE INDEX "activity_events_organizationId_occurredAt_idx" ON "activity_events"("organizationId", "occurredAt");
CREATE INDEX "activity_events_organizationId_source_action_idx" ON "activity_events"("organizationId", "source", "action");
CREATE INDEX "activity_events_organizationId_indexedAt_idx" ON "activity_events"("organizationId", "indexedAt");

-- Indexes for ActivityBackfill
CREATE UNIQUE INDEX "activity_backfills_organizationId_source_connectionRef_key" ON "activity_backfills"("organizationId", "source", "connectionRef");

-- Indexes for ActivityTriggerClaim
CREATE UNIQUE INDEX "activity_trigger_claims_eventId_flowId_key" ON "activity_trigger_claims"("eventId", "flowId");
CREATE INDEX "activity_trigger_claims_createdAt_idx" ON "activity_trigger_claims"("createdAt");

-- Foreign key constraints
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activity_backfills" ADD CONSTRAINT "activity_backfills_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
