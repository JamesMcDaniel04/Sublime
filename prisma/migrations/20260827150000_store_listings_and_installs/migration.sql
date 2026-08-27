-- The store: published agent packages and per-workspace installs. Additive.
-- Foreign keys take locks on organizations and agent_tasks; bound the wait so
-- a busy deploy fails fast and retries (migration-lock-safety.test).
SET LOCAL lock_timeout = '4s';
CREATE TABLE "store_listings" (
    "id" TEXT NOT NULL,
    "publisherOrganizationId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'Community',
    "kind" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'organization',
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "sourceAgentTaskId" TEXT,
    "publishedById" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "store_listings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "store_listings_publisherOrganizationId_slug_key" ON "store_listings"("publisherOrganizationId", "slug");
CREATE INDEX "store_listings_visibility_isActive_updatedAt_idx" ON "store_listings"("visibility", "isActive", "updatedAt");
CREATE TABLE "agent_installs" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "listingId" TEXT NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "installedVersion" INTEGER NOT NULL,
    "installedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "agent_installs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_installs_agentTaskId_key" ON "agent_installs"("agentTaskId");
CREATE INDEX "agent_installs_organizationId_listingId_idx" ON "agent_installs"("organizationId", "listingId");
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_publisherOrganizationId_fkey" FOREIGN KEY ("publisherOrganizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "store_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_installs" ADD CONSTRAINT "agent_installs_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
