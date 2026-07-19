-- Existing community skills were intentionally public. Preserve that behavior
-- while making new skills workspace-only by default.
ALTER TABLE "shared_skills"
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'organization';

UPDATE "shared_skills" SET "visibility" = 'public';

CREATE INDEX "shared_skills_organizationId_visibility_updatedAt_idx"
  ON "shared_skills"("organizationId", "visibility", "updatedAt");
