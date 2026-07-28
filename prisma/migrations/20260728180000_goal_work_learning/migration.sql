ALTER TABLE "goal_work" ADD COLUMN "signals" JSONB;
ALTER TABLE "goal_work" ADD COLUMN "probeForRuleId" TEXT;

CREATE INDEX "goal_work_probeForRuleId_idx" ON "goal_work"("probeForRuleId");

CREATE TABLE "goal_work_rules" (
    "id"             TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId"         TEXT,
    "resourceId"     TEXT,
    "seedKey"        TEXT,
    "signal"         TEXT NOT NULL,
    "statement"      TEXT NOT NULL,
    "skippedCount"   INTEGER NOT NULL,
    "totalCount"     INTEGER NOT NULL,
    "topSkipReason"  TEXT,
    "status"         TEXT NOT NULL DEFAULT 'active',
    "exploreRate"    DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "learnedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt"      TIMESTAMPTZ(6),
    "retiredReason"  TEXT,
    CONSTRAINT "goal_work_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_work_rules_organizationId_goalId_status_idx"
    ON "goal_work_rules"("organizationId", "goalId", "status");
CREATE INDEX "goal_work_rules_organizationId_seedKey_status_idx"
    ON "goal_work_rules"("organizationId", "seedKey", "status");

-- One ACTIVE rule per signal per scope, so a re-run of the weekly miner
-- updates rather than duplicating. COALESCE lets the level-1 scope
-- (goalId + resourceId) and the level-2 scope (seedKey) coexist without
-- colliding. Partial unique — migration-managed, same discipline as
-- goal_work_one_pending_per_subject.
CREATE UNIQUE INDEX "goal_work_rules_one_active_per_scope"
    ON "goal_work_rules"(
        "organizationId",
        COALESCE("goalId", ''),
        COALESCE("resourceId", ''),
        COALESCE("seedKey", ''),
        "signal"
    )
    WHERE "status" = 'active';

ALTER TABLE "goal_work_rules" ADD CONSTRAINT "goal_work_rules_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
