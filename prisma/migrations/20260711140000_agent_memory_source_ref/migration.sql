-- Task 4.5: precise purge of scan-derived learnings when a connection is
-- disconnected. sourceRef stores the stable `<plane>:<connectionRef>` key set
-- at save time by the connection scan; a plain column (unlike embeddingVec)
-- so Prisma can query it normally.
ALTER TABLE "agent_memories" ADD COLUMN "sourceRef" TEXT;

CREATE INDEX IF NOT EXISTS "agent_memories_organizationId_sourceRef_idx" ON "agent_memories" ("organizationId", "sourceRef");
