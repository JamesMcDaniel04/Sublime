-- These columns had no runtime reader or product behavior. Keeping them made
-- profile and agent settings look configurable when they were not.
ALTER TABLE "organizations"
  DROP COLUMN "trialStartDate",
  DROP COLUMN "trialEndDate";

ALTER TABLE "users"
  DROP COLUMN "timezone";

ALTER TABLE "agent_tasks"
  DROP COLUMN "type",
  DROP COLUMN "priority",
  DROP COLUMN "context";
