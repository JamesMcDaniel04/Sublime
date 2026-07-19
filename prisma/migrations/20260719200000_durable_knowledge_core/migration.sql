-- Unify uploaded files, connected-tool learning, agent outcomes, flow
-- outcomes, and normalized activity behind one durable knowledge contract.
ALTER TABLE "knowledge_documents"
  ADD COLUMN "title" TEXT,
  ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN "contentEncrypted" TEXT,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "provenance" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "retentionPolicy" TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN "lastSyncedAt" TIMESTAMPTZ(6),
  ADD COLUMN "expiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Legacy org-wide uploads must remain visible to the workspace; agent-bound
-- uploads keep the historic agent visibility behavior.
UPDATE "knowledge_documents"
SET "visibility" = CASE WHEN "agentId" IS NULL THEN 'organization' ELSE 'agent' END;

ALTER TABLE "knowledge_chunks"
  ADD COLUMN "contentEncrypted" TEXT;

CREATE UNIQUE INDEX "knowledge_documents_organizationId_sourceType_sourceId_key"
  ON "knowledge_documents"("organizationId", "sourceType", "sourceId");
CREATE INDEX "knowledge_documents_organizationId_userId_createdAt_idx"
  ON "knowledge_documents"("organizationId", "userId", "createdAt");
CREATE INDEX "knowledge_documents_organizationId_sourceType_lastSyncedAt_idx"
  ON "knowledge_documents"("organizationId", "sourceType", "lastSyncedAt");
