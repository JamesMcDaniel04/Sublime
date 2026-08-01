-- isPublished must treat a JSON null publishedGraph as unpublished.
--
-- Prisma writes `publishedGraph: null` as 'null'::jsonb (a JSON null
-- document), not SQL NULL — and reads BOTH back as JS null. App code
-- (`flow.publishedGraph != null`) therefore treats JSON null as unpublished,
-- while `publishedGraph IS NOT NULL` treats it as published. The sync
-- trigger must side with the app: either nothing is "published".

CREATE OR REPLACE FUNCTION flows_sync_trigger_columns() RETURNS trigger AS $$
BEGIN
  NEW."triggerType" := NEW."trigger"->>'type';
  NEW."triggerKey" := CASE WHEN NEW."trigger"->>'type' = 'signal' THEN NEW."trigger"->>'signal' END;
  NEW."isPublished" := NEW."publishedGraph" IS NOT NULL AND NEW."publishedGraph" <> 'null'::jsonb;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Re-true existing rows that a JSON null left marked published.
UPDATE "flows" SET
  "isPublished" = ("publishedGraph" IS NOT NULL AND "publishedGraph" <> 'null'::jsonb)
WHERE "isPublished" <> ("publishedGraph" IS NOT NULL AND "publishedGraph" <> 'null'::jsonb);
