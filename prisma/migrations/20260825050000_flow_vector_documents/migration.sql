-- Flow-owned vector collections.
--
-- Separate from the agent knowledge graph: mixing arbitrary flow documents
-- into what agents reason over would change what every agent knows as a side
-- effect of someone building a flow.

-- Lock-bounded and idempotent for the same reason the api_keys migration is:
-- an ALTER waiting on a lock does not merely fail, it blocks every write
-- queued behind it. See 20260825040000_api_keys for what that cost.
SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS "flow_vector_documents" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "collection"     TEXT NOT NULL,
  "externalId"     TEXT NOT NULL,
  "content"        TEXT NOT NULL,
  "metadata"       JSONB NOT NULL DEFAULT '{}',
  -- 1024 dimensions, matching lib/rag/embeddings EMBEDDING_DIM. A fixed width
  -- is what makes a mismatched model fail at write time rather than producing
  -- rankings that look plausible and mean nothing.
  "embedding"      vector(1024) NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "flow_vector_documents_pkey" PRIMARY KEY ("id")
);

-- Org first: the tenant guard requires organizationId in the where clause, and
-- a (collection, externalId) unique would let a crafted collection name
-- address another workspace's row.
CREATE UNIQUE INDEX IF NOT EXISTS "flow_vector_documents_org_collection_external_key"
  ON "flow_vector_documents"("organizationId", "collection", "externalId");
CREATE INDEX IF NOT EXISTS "flow_vector_documents_org_collection_idx"
  ON "flow_vector_documents"("organizationId", "collection");

-- Cosine, matching the operator the search uses (<=>). An index built for a
-- different operator class is silently ignored, leaving a sequential scan.
CREATE INDEX IF NOT EXISTS "flow_vector_documents_embedding_idx"
  ON "flow_vector_documents" USING hnsw ("embedding" vector_cosine_ops);

DO $$
DECLARE
  attempt INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flow_vector_documents_organizationId_fkey') THEN
    FOR attempt IN 1..5 LOOP
      BEGIN
        ALTER TABLE "flow_vector_documents" ADD CONSTRAINT "flow_vector_documents_organizationId_fkey"
          FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        EXIT;
      EXCEPTION WHEN lock_not_available THEN
        IF attempt = 5 THEN RAISE; END IF;
        PERFORM pg_sleep(1);
      END;
    END LOOP;
  END IF;
END $$;
