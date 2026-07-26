-- AlterTable
ALTER TABLE "goal_contributions" ADD COLUMN "estimateEdited" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "goal_contributions_seedKey_idx" ON "goal_contributions"("seedKey");
