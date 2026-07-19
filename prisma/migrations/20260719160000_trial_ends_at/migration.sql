-- Free-trial deadline for TRIAL-plan organizations. Existing orgs are
-- backfilled from their signup date so long-lived trial workspaces don't get
-- an unexpected fresh 14 days (nor an instant lockout at deploy time is
-- avoided for brand-new ones: created_at + 14 days matches the new-signup rule).
ALTER TABLE "organizations" ADD COLUMN "trialEndsAt" TIMESTAMPTZ(6);

UPDATE "organizations"
SET "trialEndsAt" = "createdAt" + INTERVAL '14 days'
WHERE "trialEndsAt" IS NULL;
