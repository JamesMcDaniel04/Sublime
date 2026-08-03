-- Reconcile historical hand-written DDL with the canonical Prisma schema so
-- fresh databases and long-lived production databases converge identically.

ALTER TABLE "organization_invitations"
  DROP CONSTRAINT "organization_invitations_organizationId_fkey";

ALTER TABLE "knowledge_documents"
  ALTER COLUMN "updatedAt" DROP DEFAULT,
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL truncated the original overlong identifier to the source name
-- below. Rename it to Prisma's deterministic 63-character identifier.
ALTER INDEX "goal_run_verdicts_organizationId_goalId_resourceId_createdAt_id"
  RENAME TO "goal_run_verdicts_organizationId_goalId_resourceId_createdA_idx";
