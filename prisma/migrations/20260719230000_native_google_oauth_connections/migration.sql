-- Native Google OAuth connections (Google blocks Nango's flow). Encrypted
-- refresh tokens live here; a nango_connections row with provider
-- 'google-native' mirrors each record for the existing read paths.

-- CreateTable
CREATE TABLE "google_oauth_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refreshTokenEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_oauth_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "google_oauth_connections_organizationId_service_idx" ON "google_oauth_connections"("organizationId", "service");

-- CreateIndex
CREATE UNIQUE INDEX "google_oauth_connections_organizationId_userId_service_acco_key" ON "google_oauth_connections"("organizationId", "userId", "service", "accountEmail");

-- AddForeignKey
ALTER TABLE "google_oauth_connections" ADD CONSTRAINT "google_oauth_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
