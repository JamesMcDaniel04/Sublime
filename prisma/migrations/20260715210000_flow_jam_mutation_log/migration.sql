-- Idempotent Flow Jam patch delivery: remember the last ~50 applied mutation
-- ids per flow so a client that times out and retries a POST can't
-- double-apply its patch or double-report conflicts.
ALTER TABLE "flows" ADD COLUMN "collaborationMutationLog" JSONB NOT NULL DEFAULT '[]';
