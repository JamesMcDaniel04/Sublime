-- The platform tier: the access axis that spans workspaces.
--
-- Two columns, because the grant is the UNION of a person and the workspace
-- they are in. An operator holds the tier only while they are in an internal
-- workspace, so moving them to a customer org revokes it immediately and there
-- is no stale flag anyone has to remember to clear.
--
-- Both defaults are the safe answer for every row that already exists: nobody
-- has a platform role, and every existing workspace is a customer. Granting the
-- tier is therefore a deliberate, auditable UPDATE — never a side effect of
-- this migration.
--
-- See src/lib/server/platform-roles.ts for the semantics and
-- src/lib/server/platform-owner.ts for the identity root that does not depend
-- on these columns being correct.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platformRole" TEXT;

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'customer';

-- Constrain both to their allowed values. A typo ('Operator', 'admin') would
-- otherwise read as "no tier" and fail silently in the safe direction, which is
-- exactly the kind of quiet mistake that is hard to notice when someone expects
-- access and does not get it.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_platformRole_check";
ALTER TABLE "users" ADD CONSTRAINT "users_platformRole_check"
  CHECK ("platformRole" IS NULL OR "platformRole" IN ('staff', 'operator'));

ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_kind_check";
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_kind_check"
  CHECK ("kind" IN ('internal', 'partner', 'customer'));

-- Operator lookups are "who holds the tier", never "what is this one user's
-- role", so the index is partial: it covers only the handful of rows that carry
-- a value and costs nothing on the overwhelming majority that do not.
CREATE INDEX IF NOT EXISTS "users_platformRole_idx" ON "users"("platformRole") WHERE "platformRole" IS NOT NULL;
