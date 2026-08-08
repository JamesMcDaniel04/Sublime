-- The original Slack schema created this as an index, not a constraint. The
-- user-ownership migration attempted DROP CONSTRAINT, so already-migrated
-- databases can still enforce one Slack workspace per organization. Personal
-- connections must permit two members to connect the same Slack team.
DROP INDEX IF EXISTS "slack_workspace_connections_organizationId_teamId_key";
