-- Everything present at rollout time belongs to the owner's test cohort.
-- Grant those workspaces permanent unrestricted access and promote every
-- current test user to the application's highest role. Defaults remain
-- unchanged, so accounts created after this migration must subscribe.
ALTER TABLE "organizations"
  ADD COLUMN "grandfatheredAt" TIMESTAMPTZ(6);

UPDATE "organizations"
SET
  "grandfatheredAt" = CURRENT_TIMESTAMP,
  "plan" = 'ENTERPRISE',
  "settings" = COALESCE("settings", '{}'::jsonb) - 'customLimits';

UPDATE "users" SET "role" = 'ADMIN';
