-- Workspace-scoped constants, referenced as {{workspace.<key>}}.
--
-- Plain text by design: these are channel ids, thresholds and base URLs that
-- every member may read. Secrets stay in the credential vault, which has
-- placeholder-only reveal and key rotation — neither of which this table has,
-- and the API refuses credential-shaped keys so the distinction cannot erode.
CREATE TABLE "workspace_variables" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "key"            TEXT NOT NULL,
  "value"          TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workspace_variables_pkey" PRIMARY KEY ("id")
);

-- One value per key per workspace; the unique index is what makes an upsert
-- by (org, key) safe under concurrent writes.
CREATE UNIQUE INDEX "workspace_variables_organizationId_key_key"
  ON "workspace_variables" ("organizationId", "key");
CREATE INDEX "workspace_variables_organizationId_idx"
  ON "workspace_variables" ("organizationId");

ALTER TABLE "workspace_variables"
  ADD CONSTRAINT "workspace_variables_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
