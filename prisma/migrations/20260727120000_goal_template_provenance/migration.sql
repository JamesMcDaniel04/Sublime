-- Goal template provenance (spec 2026-07-27): remember which goal template
-- created a goal so its curated agent bundle can be offered after creation.
-- Nullable: Copilot-drafted and manually-created goals have no template.
ALTER TABLE "goals" ADD COLUMN "templateKey" TEXT;
