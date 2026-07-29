-- Restricted goals: an optional per-goal access boundary.
--
-- Additive with a default, so every existing goal keeps its current behaviour
-- and no backfill is needed. A goal only becomes restricted when an admin
-- explicitly says so.
ALTER TABLE "goals" ADD COLUMN "access" TEXT NOT NULL DEFAULT 'workspace';

-- Membership is consulted ONLY when access = 'restricted', so unrestricted
-- goals never have rows here. The composite primary key makes membership
-- idempotent: adding the same person twice is a no-op rather than a duplicate.
CREATE TABLE "goal_members" (
    "goalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goal_members_pkey" PRIMARY KEY ("goalId","userId")
);

-- Indexed by userId because the hot read is "which restricted goals may THIS
-- person see" — evaluated on every goal list and every scope resolution.
CREATE INDEX "goal_members_userId_idx" ON "goal_members"("userId");

ALTER TABLE "goal_members" ADD CONSTRAINT "goal_members_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Membership of a goal that is not restricted is meaningless but harmless, so
-- there is deliberately no CHECK tying the two together: an admin may add
-- members BEFORE flipping access, which is the natural order to do it in.
