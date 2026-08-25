-- Flow-owned vector collections.
--
-- Separate from the agent knowledge graph: mixing arbitrary flow documents
-- into what agents reason over would change what every agent knows as a side
-- effect of someone building a flow.

CREATE TABLE "flow_vector_documents" (
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
CREATE UNIQUE INDEX "flow_vector_documents_org_collection_external_key"
  ON "flow_vector_documents"("organizationId", "collection", "externalId");
CREATE INDEX "flow_vector_documents_org_collection_idx"
  ON "flow_vector_documents"("organizationId", "collection");

-- Cosine, matching the operator the search uses (<=>). An index built for a
-- different operator class is silently ignored, leaving a sequential scan.
CREATE INDEX "flow_vector_documents_embedding_idx"
  ON "flow_vector_documents" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "flow_vector_documents" ADD CONSTRAINT "flow_vector_documents_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
