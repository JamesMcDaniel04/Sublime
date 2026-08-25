-- Public API keys.
--
-- The plaintext key is shown once and never stored: `prefix` is the public
-- handle a presented key uses to find its row, and `hash` is what proves the
-- presenter holds the real key.

CREATE TABLE "api_keys" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "createdById"    TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "prefix"         TEXT NOT NULL,
  "hash"           TEXT NOT NULL,
  "scopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastUsedAt"     TIMESTAMPTZ(6),
  "expiresAt"      TIMESTAMPTZ(6),
  "revokedAt"      TIMESTAMPTZ(6),
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- Unique: a presented key is looked up by prefix, so two rows sharing one
-- would make authentication ambiguous.
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");
CREATE INDEX "api_keys_organizationId_idx" ON "api_keys"("organizationId");

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "api_key_usage" (
  "id"             TEXT NOT NULL,
  "apiKeyId"       TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "route"          TEXT NOT NULL,
  "status"         INTEGER NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_key_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_key_usage_apiKeyId_createdAt_idx" ON "api_key_usage"("apiKeyId", "createdAt");
CREATE INDEX "api_key_usage_organizationId_createdAt_idx" ON "api_key_usage"("organizationId", "createdAt");
