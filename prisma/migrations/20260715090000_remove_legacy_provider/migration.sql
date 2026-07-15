-- Remove the retired provider integration and its provider-specific saved queries.
DROP TABLE IF EXISTS "public"."people_ai_connections";
DROP TABLE IF EXISTS "public"."custom_signals";

ALTER TABLE "public"."organizations"
  DROP COLUMN IF EXISTS "peopleAiTeamId",
  DROP COLUMN IF EXISTS "peopleAiWebhookSecret",
  DROP COLUMN IF EXISTS "entitlementTier",
  DROP COLUMN IF EXISTS "entitlementStatus",
  DROP COLUMN IF EXISTS "entitlementCheckedAt";

ALTER TABLE "public"."users"
  DROP COLUMN IF EXISTS "peopleAiMembershipId";
