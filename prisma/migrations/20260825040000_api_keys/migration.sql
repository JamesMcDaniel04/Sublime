-- Public API keys.
--
-- The plaintext key is shown once and never stored: `prefix` is the public
-- handle a presented key uses to find its row, and `hash` is what proves the
-- presenter holds the real key.
--
-- ── Why this migration is written defensively ────────────────────────────────
--
-- Its first production run timed out after two minutes, part-applied, and left
-- the deploy pipeline blocked (P3018). Two separate faults, both fixed here.
--
-- 1. NO LOCK TIMEOUT. `ALTER TABLE … ADD FOREIGN KEY` takes SHARE ROW EXCLUSIVE
--    on the PARENT table, and `users` is written on every authenticated request
--    (touchLastSeen). With no bound, the ALTER queued — and a queued lock
--    request blocks every write behind it, so the deploy did not merely fail,
--    it degraded production for the whole two minutes. `lock_timeout` makes it
--    give up in seconds instead of taking traffic down with it.
--
-- 2. NOT IDEMPOTENT. It part-applied (table, indexes and one FK landed; the
--    second FK and api_key_usage did not), so a retry would have failed on
--    objects that already existed. Every statement below can now run against a
--    fresh, part-applied, or fully-applied database.
SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS "api_keys" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_prefix_key" ON "api_keys"("prefix");
CREATE INDEX IF NOT EXISTS "api_keys_organizationId_idx" ON "api_keys"("organizationId");

CREATE TABLE IF NOT EXISTS "api_key_usage" (
  "id"             TEXT NOT NULL,
  "apiKeyId"       TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "route"          TEXT NOT NULL,
  "status"         INTEGER NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_key_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "api_key_usage_apiKeyId_createdAt_idx" ON "api_key_usage"("apiKeyId", "createdAt");
CREATE INDEX IF NOT EXISTS "api_key_usage_organizationId_createdAt_idx" ON "api_key_usage"("organizationId", "createdAt");

-- Foreign keys last, and guarded.
--
-- Retried rather than attempted once: the lock is usually free within a second
-- or two between writes, and giving up on the first miss would fail deploys
-- for no reason. Retried a BOUNDED number of times, so a genuinely contended
-- table fails the deploy quickly and visibly instead of hanging.
DO $$
DECLARE
  attempt INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_organizationId_fkey') THEN
    FOR attempt IN 1..5 LOOP
      BEGIN
        ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF attempt = 5 THEN RAISE; END IF;
        PERFORM pg_sleep(1);
      END;
    END LOOP;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_createdById_fkey') THEN
    FOR attempt IN 1..5 LOOP
      BEGIN
        ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdById_fkey"
          FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF attempt = 5 THEN RAISE; END IF;
        PERFORM pg_sleep(1);
      END;
    END LOOP;
  END IF;
END $$;
