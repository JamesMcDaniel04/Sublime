-- RBAC permission core: rename the non-admin role and repair admin-less orgs.
--
-- RENAME VALUE rewrites the enum type in place, so every existing users /
-- organization_invitations row keeps its role with no data migration and no
-- rewrite of the tables. It is transaction-safe (unlike ADD VALUE), so it runs
-- inside Prisma's migration transaction.
ALTER TYPE "UserRole" RENAME VALUE 'USER' TO 'MEMBER';

-- Column defaults reference the enum member by OID, so the rename already
-- carries them. Restated so the deployed schema matches prisma/schema.prisma
-- exactly rather than matching only by accident.
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
ALTER TABLE "organization_invitations" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- Conditional repair, NOT a blanket promotion. Provisioning already assigns
-- ADMIN to a user who arrives without an invitation (see
-- src/lib/supabase/auth-utils.ts), so most workspaces already have one. Only
-- organizations that somehow hold active users but zero active admins are
-- touched; there, the earliest-created active user — the workspace creator
-- under the current bootstrap flow — is promoted.
WITH orgs_without_admin AS (
  SELECT o."id"
  FROM "organizations" o
  WHERE EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."organizationId" = o."id" AND u."isActive"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."organizationId" = o."id" AND u."isActive" AND u."role" = 'ADMIN'
    )
),
promote AS (
  SELECT DISTINCT ON (u."organizationId") u."id"
  FROM "users" u
  JOIN orgs_without_admin owa ON owa."id" = u."organizationId"
  WHERE u."isActive"
  -- id breaks ties so the choice is deterministic when two users share a
  -- createdAt (possible for seeded/imported workspaces).
  ORDER BY u."organizationId", u."createdAt" ASC, u."id" ASC
)
UPDATE "users" SET "role" = 'ADMIN' WHERE "id" IN (SELECT "id" FROM promote);

-- Fail the deploy rather than ship a workspace nobody can administer. An org
-- with no active users at all is fine (nothing to administer); an org with
-- active users and no admin is not.
DO $$
DECLARE
  orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned
  FROM "organizations" o
  WHERE EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."organizationId" = o."id" AND u."isActive"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "users" u
      WHERE u."organizationId" = o."id" AND u."isActive" AND u."role" = 'ADMIN'
    );
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'RBAC backfill left % organization(s) with active users but no active ADMIN', orphaned;
  END IF;
END $$;
