-- Credentials are private capability grants, not workspace catalogue data.
-- Attribute legacy shared rows to their creator. If that would collide with an
-- existing personal name, retain both with an explicit legacy suffix. Rows
-- without a trustworthy creator are quarantined inactive rather than assigned
-- to an organization owner.
UPDATE "credentials" AS credential
SET "userId" = credential."createdById"
WHERE credential."userId" IS NULL
  AND credential."createdById" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "users" AS creator
    WHERE creator."id" = credential."createdById"
      AND creator."organizationId" = credential."organizationId"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "credentials" AS personal
    WHERE personal."organizationId" = credential."organizationId"
      AND personal."userId" = credential."createdById"
      AND personal."name" = credential."name"
  );

UPDATE "credentials" AS credential
SET
  "name" = credential."name" || ' (legacy ' || substring(credential."id" from 1 for 8) || ')',
  "userId" = credential."createdById"
WHERE credential."userId" IS NULL
  AND credential."createdById" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "users" AS creator
    WHERE creator."id" = credential."createdById"
      AND creator."organizationId" = credential."organizationId"
  );

UPDATE "credentials"
SET "isActive" = false
WHERE "userId" IS NULL;
