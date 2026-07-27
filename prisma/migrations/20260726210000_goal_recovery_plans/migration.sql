-- Goal recovery plans: AI-generated get-back-on-track plans (spec 2026-07-26).
CREATE TABLE "goal_recovery_plans" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "triggerRiskLevel" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "modelMeta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    CONSTRAINT "goal_recovery_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goal_recovery_actions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "rank" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "resultRef" TEXT,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goal_recovery_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_recovery_plans_organizationId_goalId_status_idx"
    ON "goal_recovery_plans"("organizationId", "goalId", "status");
-- One open plan per goal (partial unique — migration-managed, not in schema.prisma).
CREATE UNIQUE INDEX "goal_recovery_plans_one_open_per_goal"
    ON "goal_recovery_plans"("goalId") WHERE "status" = 'open';
CREATE INDEX "goal_recovery_actions_planId_idx" ON "goal_recovery_actions"("planId");

ALTER TABLE "goal_recovery_plans" ADD CONSTRAINT "goal_recovery_plans_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_plans" ADD CONSTRAINT "goal_recovery_plans_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_actions" ADD CONSTRAINT "goal_recovery_actions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_actions" ADD CONSTRAINT "goal_recovery_actions_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "goal_recovery_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
