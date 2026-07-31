-- Denormalized trigger/publish facts for event-side flow matching.
--
-- Activity ingestion, Slack ingress, and signal emission previously loaded
-- EVERY active flow's trigger + full publishedGraph per event just to match a
-- handful of listeners in memory — event-rate-driven load that multiplied
-- with busy Slack workspaces independent of user count.
--
-- Maintained by a BEFORE trigger (not app code): the Flow row is written from
-- many sites (create, update, publish, restore, jam patches, template
-- provisioning, intelligence drafts) and app-side maintenance would drift.

ALTER TABLE "flows" ADD COLUMN "triggerType" TEXT;
ALTER TABLE "flows" ADD COLUMN "triggerKey" TEXT;
ALTER TABLE "flows" ADD COLUMN "isPublished" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION flows_sync_trigger_columns() RETURNS trigger AS $$
BEGIN
  NEW."triggerType" := NEW."trigger"->>'type';
  NEW."triggerKey" := CASE WHEN NEW."trigger"->>'type' = 'signal' THEN NEW."trigger"->>'signal' END;
  NEW."isPublished" := NEW."publishedGraph" IS NOT NULL;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER flows_sync_trigger_columns
BEFORE INSERT OR UPDATE ON "flows"
FOR EACH ROW EXECUTE FUNCTION flows_sync_trigger_columns();

-- Backfill existing rows.
UPDATE "flows" SET
  "triggerType" = "trigger"->>'type',
  "triggerKey" = CASE WHEN "trigger"->>'type' = 'signal' THEN "trigger"->>'signal' END,
  "isPublished" = ("publishedGraph" IS NOT NULL);

CREATE INDEX "flows_organizationId_status_triggerType_idx" ON "flows"("organizationId", "status", "triggerType");
