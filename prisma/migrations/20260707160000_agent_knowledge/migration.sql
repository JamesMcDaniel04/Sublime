-- Agent knowledge: uploaded files extracted to text, chunked, and embedded.
CREATE TABLE "knowledge_documents" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "agentId" TEXT,
  "userId" TEXT,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL DEFAULT 0,
  "charCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_chunks" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "agentId" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "content" TEXT NOT NULL,
  "embedding" JSONB,
  CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_documents_organizationId_agentId_idx" ON "knowledge_documents"("organizationId", "agentId");
CREATE INDEX "knowledge_chunks_organizationId_agentId_idx" ON "knowledge_chunks"("organizationId", "agentId");

ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
