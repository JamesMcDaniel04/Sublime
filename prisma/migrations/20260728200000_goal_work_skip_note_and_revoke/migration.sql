-- Free text for the one skip reason the closed vocabulary could not name.
-- Kept separate from skipReason so reasons stay countable without an LLM,
-- which is what makes targeting rules derivable at all.
ALTER TABLE "goal_work" ADD COLUMN "skipNote" TEXT;

-- A rule a human deliberately turned off must be distinguishable from one the
-- evidence killed, so 'revoked' carries who did it.
ALTER TABLE "goal_work_rules" ADD COLUMN "revokedByUserId" TEXT;
