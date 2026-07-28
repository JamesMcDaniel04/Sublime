CREATE TABLE "goal_work" (
    "id"             TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId"         TEXT NOT NULL,
    "resourceType"   TEXT NOT NULL,
    "resourceId"     TEXT NOT NULL,
    "runId"          TEXT,
    "subject"        TEXT NOT NULL,
    "subjectRef"     TEXT,
    "produced"       TEXT NOT NULL,
    "body"           TEXT,
    "bodyFormat"     TEXT NOT NULL DEFAULT 'markdown',
    -- User.id is a cuid (supabaseId is the uuid), so user references are TEXT.
    "assigneeUserId" TEXT,
    "disposition"    TEXT NOT NULL DEFAULT 'pending',
    "dispositionBy"  TEXT,
    "dispositionAt"  TIMESTAMPTZ(6),
    "skipReason"     TEXT,
    "outcome"        TEXT NOT NULL DEFAULT 'unknown',
    "outcomeSource"  TEXT,
    "outcomeNote"    TEXT,
    "outcomeAt"      TIMESTAMPTZ(6),
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goal_work_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_work_organizationId_goalId_disposition_idx"
    ON "goal_work"("organizationId", "goalId", "disposition");
CREATE INDEX "goal_work_goalId_assigneeUserId_disposition_idx"
    ON "goal_work"("goalId", "assigneeUserId", "disposition");
CREATE INDEX "goal_work_goalId_resourceId_idx"
    ON "goal_work"("goalId", "resourceId");

-- One PENDING item per subject per goal (partial unique — migration-managed,
-- not expressible in schema.prisma). Without it a daily agent redrafts the
-- same subjects every morning and the queue is unusable by Thursday. Once an
-- item is dispositioned the subject is free again, which is correct for a deal
-- that stalls twice. Same discipline as goal_recovery_plans_one_open_per_goal.
CREATE UNIQUE INDEX "goal_work_one_pending_per_subject"
    ON "goal_work"("goalId", "subjectRef")
    WHERE "disposition" = 'pending' AND "subjectRef" IS NOT NULL;

ALTER TABLE "goal_work" ADD CONSTRAINT "goal_work_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_work" ADD CONSTRAINT "goal_work_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
