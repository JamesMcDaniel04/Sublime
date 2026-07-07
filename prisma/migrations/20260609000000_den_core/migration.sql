-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."Plan" AS ENUM ('TRIAL', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "public"."IntegrationType" AS ENUM ('GITHUB', 'SLACK', 'LINEAR', 'ASANA', 'MONDAY', 'JIRA', 'FIGMA', 'TRELLO', 'CLICKUP', 'ZENDESK', 'GOOGLE_DRIVE');

-- CreateEnum
CREATE TYPE "public"."MCPAgentType" AS ENUM ('GITHUB', 'SLACK', 'MONDAY', 'JIRA', 'ZENDESK', 'LINEAR', 'ASANA', 'TRELLO');

-- CreateTable
CREATE TABLE "public"."organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" "public"."Plan" NOT NULL DEFAULT 'TRIAL',
    "trialStartDate" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndDate" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" TEXT NOT NULL,
    "supabaseId" UUID NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "imageUrl" TEXT,
    "role" "public"."UserRole" NOT NULL DEFAULT 'USER',
    "organizationId" UUID,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMPTZ(6),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_tasks" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'agent',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "agentType" TEXT NOT NULL DEFAULT 'CUSTOM',
    "description" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "organizationId" UUID NOT NULL,
    "metadata" JSONB,
    "lastExecutedAt" TIMESTAMP(3),
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_executions" (
    "id" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "agentTemplateId" TEXT,
    "agentTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "executionTime" INTEGER,
    "trigger" JSONB NOT NULL,
    "metadata" JSONB,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."workflow_steps" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."workflow_events" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "configuration" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "schedule" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "metadata" JSONB,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."custom_dashboards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."integrations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" "public"."IntegrationType" NOT NULL,
    "provider" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMPTZ(6),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'connected',
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastOauthRefresh" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."mcp_agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "agentType" "public"."MCPAgentType" NOT NULL,
    "description" TEXT,
    "mcpServerUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "public"."organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_supabaseId_key" ON "public"."users"("supabaseId");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "public"."users"("organizationId");

-- CreateIndex
CREATE INDEX "agent_tasks_organizationId_status_idx" ON "public"."agent_tasks"("organizationId", "status");

-- CreateIndex
CREATE INDEX "agent_executions_organizationId_startedAt_idx" ON "public"."agent_executions"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_executions_agentTaskId_idx" ON "public"."agent_executions"("agentTaskId");

-- CreateIndex
CREATE INDEX "workflow_steps_executionId_createdAt_idx" ON "public"."workflow_steps"("executionId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_events_executionId_ts_idx" ON "public"."workflow_events"("executionId", "ts");

-- CreateIndex
CREATE INDEX "agent_templates_organizationId_isActive_idx" ON "public"."agent_templates"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "custom_dashboards_organizationId_idx" ON "public"."custom_dashboards"("organizationId");

-- CreateIndex
CREATE INDEX "integrations_organizationId_provider_idx" ON "public"."integrations"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_userId_provider_key" ON "public"."integrations"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_agents_userId_organizationId_agentType_key" ON "public"."mcp_agents"("userId", "organizationId", "agentType");

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_tasks" ADD CONSTRAINT "agent_tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_executions" ADD CONSTRAINT "agent_executions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_executions" ADD CONSTRAINT "agent_executions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_executions" ADD CONSTRAINT "agent_executions_agentTemplateId_fkey" FOREIGN KEY ("agentTemplateId") REFERENCES "public"."agent_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_executions" ADD CONSTRAINT "agent_executions_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "public"."agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."workflow_steps" ADD CONSTRAINT "workflow_steps_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "public"."agent_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."workflow_events" ADD CONSTRAINT "workflow_events_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "public"."agent_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."workflow_events" ADD CONSTRAINT "workflow_events_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."workflow_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_templates" ADD CONSTRAINT "agent_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_templates" ADD CONSTRAINT "agent_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."custom_dashboards" ADD CONSTRAINT "custom_dashboards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."custom_dashboards" ADD CONSTRAINT "custom_dashboards_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integrations" ADD CONSTRAINT "integrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."integrations" ADD CONSTRAINT "integrations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mcp_agents" ADD CONSTRAINT "mcp_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mcp_agents" ADD CONSTRAINT "mcp_agents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
