-- Workspace deletion was the one admin action that erased its own audit
-- trail: audit_events cascaded away with the organization, including any rows
-- recording the deleting admin's own takeovers. SET NULL keeps the rows as
-- org-less orphans that a database operator (or regulator) can still read.
ALTER TABLE "public"."audit_events" ALTER COLUMN "organizationId" DROP NOT NULL;

ALTER TABLE "public"."audit_events" DROP CONSTRAINT "audit_events_organizationId_fkey";

ALTER TABLE "public"."audit_events" ADD CONSTRAINT "audit_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
