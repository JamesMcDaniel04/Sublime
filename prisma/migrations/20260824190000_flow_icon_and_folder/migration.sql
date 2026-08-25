-- Flow card icon and workbook-style folder grouping.
--
-- Both default to '' rather than being nullable: '' is a real value here
-- ("default glyph", "ungrouped") and NOT NULL DEFAULT '' keeps every read
-- path free of null handling. Existing rows take the default in place, so
-- this is a metadata-only change on Postgres 11+ — no table rewrite.
ALTER TABLE "flows" ADD COLUMN "icon" TEXT NOT NULL DEFAULT '';
ALTER TABLE "flows" ADD COLUMN "folder" TEXT NOT NULL DEFAULT '';

-- Folders are browsed by name within a workspace; without this the list view
-- sorts and groups by a sequential scan once a workspace has many flows.
CREATE INDEX IF NOT EXISTS "flows_organizationId_folder_idx" ON "flows" ("organizationId", "folder");
