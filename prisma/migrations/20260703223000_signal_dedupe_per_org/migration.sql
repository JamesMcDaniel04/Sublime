-- Signal dedupeKey: global-unique → org-scoped unique, so a raw provider event
-- id from one tenant can't dedupe-drop another tenant's signal.
DROP INDEX "signals_dedupeKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "signals_organizationId_dedupeKey_key" ON "signals"("organizationId", "dedupeKey");
