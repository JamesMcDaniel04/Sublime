-- Native integration credentials are personal even inside a shared org.
-- Existing org-wide rows have no trustworthy owner, so quarantine them and
-- require an explicit reconnect rather than gifting them to an administrator.
ALTER TABLE "integration_secrets" ADD COLUMN "userId" TEXT;
ALTER TABLE "slack_workspace_connections" ADD COLUMN "userId" TEXT;

UPDATE "integration_secrets" SET "isActive" = false WHERE "userId" IS NULL;
UPDATE "slack_workspace_connections" SET "status" = 'revoked' WHERE "userId" IS NULL;

ALTER TABLE "integration_secrets"
  ADD CONSTRAINT "integration_secrets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_workspace_connections"
  ADD CONSTRAINT "slack_workspace_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "integration_secrets_organizationId_provider_key";
DROP INDEX IF EXISTS "integration_secrets_organizationId_isActive_idx";
ALTER TABLE "slack_workspace_connections"
  DROP CONSTRAINT IF EXISTS "slack_workspace_connections_organizationId_teamId_key";

CREATE UNIQUE INDEX "integration_secrets_organizationId_userId_provider_key"
  ON "integration_secrets"("organizationId", "userId", "provider");
CREATE INDEX "integration_secrets_organizationId_userId_isActive_idx"
  ON "integration_secrets"("organizationId", "userId", "isActive");
CREATE UNIQUE INDEX "slack_workspace_connections_organizationId_userId_teamId_key"
  ON "slack_workspace_connections"("organizationId", "userId", "teamId");
CREATE INDEX "slack_workspace_connections_organizationId_userId_status_idx"
  ON "slack_workspace_connections"("organizationId", "userId", "status");
