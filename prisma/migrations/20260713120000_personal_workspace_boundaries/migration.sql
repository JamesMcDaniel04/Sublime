-- Organization membership shares the integration/template catalog, not user
-- content or credentials. Existing user-created agents/flows become personal.
ALTER TABLE "agent_tasks" ALTER COLUMN "visibility" SET DEFAULT 'private';
ALTER TABLE "flows" ALTER COLUMN "visibility" SET DEFAULT 'private';

UPDATE "agent_tasks"
SET "visibility" = 'private'
WHERE "userId" IS NOT NULL;

UPDATE "flows"
SET "visibility" = 'private'
WHERE "userId" IS NOT NULL;

UPDATE "mcp_connections" AS connection
SET "userId" = (
  SELECT "id" FROM "users"
  WHERE "organizationId" = connection."organizationId"
    AND "role" = 'ADMIN' AND "isActive" = true
  ORDER BY "createdAt" ASC LIMIT 1
)
WHERE connection."userId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "users"
    WHERE "organizationId" = connection."organizationId"
      AND "role" = 'ADMIN' AND "isActive" = true
  );

UPDATE "nango_connections" AS connection
SET "userId" = (
  SELECT "id" FROM "users"
  WHERE "organizationId" = connection."organizationId"
    AND "role" = 'ADMIN' AND "isActive" = true
  ORDER BY "createdAt" ASC LIMIT 1
)
WHERE connection."userId" IS NULL
  AND EXISTS (
    SELECT 1 FROM "users"
    WHERE "organizationId" = connection."organizationId"
      AND "role" = 'ADMIN' AND "isActive" = true
  );

CREATE INDEX IF NOT EXISTS "mcp_connections_organizationId_userId_isActive_idx"
  ON "mcp_connections"("organizationId", "userId", "isActive");

CREATE INDEX IF NOT EXISTS "nango_connections_organizationId_userId_status_idx"
  ON "nango_connections"("organizationId", "userId", "status");
