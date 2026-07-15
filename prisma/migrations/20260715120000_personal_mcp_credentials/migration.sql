-- Custom MCP credentials were historically created with "userId" = NULL,
-- which made them usable by every member of the organization. Ownership
-- cannot be reconstructed safely, so deactivate those legacy rows and require
-- their original users to reconnect. Platform-managed provider rows remain
-- organization-scoped.
UPDATE "mcp_connections"
SET "isActive" = false,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "userId" IS NULL
  AND "provider" IS NULL
  AND "isActive" = true;
