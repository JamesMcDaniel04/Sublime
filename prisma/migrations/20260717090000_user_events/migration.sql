CREATE TABLE "user_events" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "context" JSONB NOT NULL DEFAULT '{}',
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "indexedAt" TIMESTAMP(3),
  CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_events_organizationId_occurredAt_idx" ON "user_events"("organizationId", "occurredAt");
CREATE INDEX "user_events_userId_occurredAt_idx" ON "user_events"("userId", "occurredAt");
CREATE INDEX "user_events_organizationId_indexedAt_idx" ON "user_events"("organizationId", "indexedAt");

ALTER TABLE "user_events" ADD CONSTRAINT "user_events_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
