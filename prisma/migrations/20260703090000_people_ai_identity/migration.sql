-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "peopleAiTeamId" TEXT,
ADD COLUMN "entitlementTier" TEXT,
ADD COLUMN "entitlementStatus" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN "entitlementCheckedAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN "peopleAiMembershipId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_peopleAiTeamId_key" ON "organizations"("peopleAiTeamId");

-- CreateTable
CREATE TABLE "people_ai_connections" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "membershipId" TEXT,
    "scope" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_ai_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "people_ai_connections_organizationId_userId_key" ON "people_ai_connections"("organizationId", "userId");

-- AddForeignKey
ALTER TABLE "people_ai_connections" ADD CONSTRAINT "people_ai_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_ai_connections" ADD CONSTRAINT "people_ai_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
