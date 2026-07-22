-- Login/bootstrap hot paths: cover each private/shared agent branch and its
-- updated-at ordering without scanning every row in the organization.
CREATE INDEX "agent_tasks_organizationId_userId_status_updatedAt_idx"
  ON "agent_tasks"("organizationId", "userId", "status", "updatedAt");

CREATE INDEX "agent_tasks_organizationId_visibility_status_updatedAt_idx"
  ON "agent_tasks"("organizationId", "visibility", "status", "updatedAt");

-- Selected-agent activity polling is always scoped to the authenticated user.
CREATE INDEX "agent_executions_organizationId_userId_agentTaskId_startedAt_idx"
  ON "agent_executions"("organizationId", "userId", "agentTaskId", "startedAt");

-- Notification lists and mirrored connection reads sort/update within a user.
CREATE INDEX "notifications_organizationId_userId_createdAt_idx"
  ON "notifications"("organizationId", "userId", "createdAt");

CREATE INDEX "nango_connections_organizationId_userId_updatedAt_idx"
  ON "nango_connections"("organizationId", "userId", "updatedAt");
