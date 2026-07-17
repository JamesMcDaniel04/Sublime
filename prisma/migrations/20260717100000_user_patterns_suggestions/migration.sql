CREATE TABLE "user_patterns" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "occurrenceCount" INTEGER NOT NULL,
  "firstSeenAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "user_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_patterns_userId_slug_key" ON "user_patterns"("userId", "slug");
CREATE INDEX "user_patterns_organizationId_userId_status_idx" ON "user_patterns"("organizationId", "userId", "status");

ALTER TABLE "user_patterns" ADD CONSTRAINT "user_patterns_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_suggestions" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "flowId" TEXT,
  "targetType" TEXT,
  "targetId" TEXT,
  "sourcePatternSlugs" JSONB NOT NULL DEFAULT '[]',
  "evidence" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "user_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_suggestions_organizationId_userId_status_idx" ON "user_suggestions"("organizationId", "userId", "status");

ALTER TABLE "user_suggestions" ADD CONSTRAINT "user_suggestions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
